const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const puppeteerStealth = require('puppeteer-extra-plugin-stealth');

puppeteer.use(puppeteerStealth());

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return clean(value).toLowerCase();
}

function normalizeForCompare(value) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', ё: 'e', є: 'e', ж: 'zh', з: 'z',
    и: 'i', і: 'i', ї: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '',
    ы: 'y', ъ: '', э: 'e', ю: 'yu', я: 'ya'
  };

  return normalizeKey(value)
    .split('')
    .map((char) => (map[char] !== undefined ? map[char] : char))
    .join('')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cityMatches(candidateCity, queryCity) {
  if (!clean(queryCity)) return true;
  if (!clean(candidateCity)) return true;

  const candidate = normalizeForCompare(candidateCity);
  const query = normalizeForCompare(queryCity);

  if (candidate.includes(query) || query.includes(candidate)) {
    return true;
  }

  const toStem = (value) => value
    .split(' ')
    .map((token) => token.replace(/(iv|ov|ev|yv|yi|iy|yy|iyiv|yiv|vsk|sk|ska|skiy|y)$/i, ''))
    .join(' ')
    .trim();

  const candidateStem = toStem(candidate);
  const queryStem = toStem(query);

  if (!candidateStem || !queryStem) {
    return false;
  }

  return candidateStem.includes(queryStem) || queryStem.includes(candidateStem);
}

function buildAvatarUrl(name, position) {
  const label = clean(name || position || 'Кандидат');
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(label)}&background=0f172a&color=ffffff&size=256&bold=true`;
}

function employmentMatches(text, employmentType) {
  const normalizedText = normalizeKey(text);

  if (employmentType === 'full-time') {
    return /(повна|full[- ]?time|полная)/i.test(normalizedText);
  }

  if (employmentType === 'part-time') {
    return /(неповна|часткова|part[- ]?time|частичн)/i.test(normalizedText);
  }

  if (employmentType === 'remote') {
    return /(віддален|дистанційн|удален|remote)/i.test(normalizedText);
  }

  return true;
}

function parseAgeFromBirthDate(text) {
  const match = clean(text).match(/(\d{1,2})\s+([а-яіїєґ]+)\s+(\d{4})/i);
  if (!match) return '';

  const day = Number(match[1]);
  const monthName = match[2].toLowerCase();
  const year = Number(match[3]);
  const months = {
    січня: 0,
    лютого: 1,
    березня: 2,
    квітня: 3,
    травня: 4,
    червня: 5,
    липня: 6,
    серпня: 7,
    вересня: 8,
    жовтня: 9,
    листопада: 10,
    грудня: 11,
    января: 0,
    февраля: 1,
    марта: 2,
    апреля: 3,
    мая: 4,
    июня: 5,
    июля: 6,
    августа: 7,
    сентября: 8,
    октября: 9,
    ноября: 10,
    декабря: 11
  };

  const month = months[monthName];
  if (month === undefined) return '';

  const birthDate = new Date(year, month, day);
  if (Number.isNaN(birthDate.getTime())) return '';

  const now = new Date();
  let age = now.getFullYear() - birthDate.getFullYear();
  const monthDiff = now.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birthDate.getDate())) {
    age -= 1;
  }

  return Number.isFinite(age) && age > 0 ? String(age) : '';
}

function parseSearchCard(blockText) {
  const lines = String(blockText || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(clean)
    .filter(Boolean);

  const metaLine = lines.find((line) => /\d+\s*(?:років?|роки|year|years|лет)/i.test(line)) || '';
  const metaMatch = metaLine.match(/^(?<name>[^,]+),\s*(?<age>\d{1,3})\s*(?:років?|роки|years?|лет)?(?:,\s*(?<city>[^,]+))?/i);
  const employmentLine = lines.find((line) => /(повна|неповна|часткова|part[- ]?time|full[- ]?time|дистанційно|віддалена)/i.test(line)) || '';

  return {
    name: clean(metaMatch?.groups?.name || lines[0] || ''),
    age: clean(metaMatch?.groups?.age || ''),
    city: clean(metaMatch?.groups?.city || ''),
    employmentType: clean(employmentLine || ''),
    description: lines.slice(1).join(' ')
  };
}

function extractPositionKeywords(position) {
  const stopWords = new Set(['и', 'й', 'та', 'з', 'на', 'по', 'for', 'the']);
  const tokens = normalizeForCompare(position)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token));

  return Array.from(new Set(tokens));
}

function extractExperienceYearsFromText(text, position) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(clean).filter(Boolean);
  const keywords = extractPositionKeywords(position);
  const yearsRe = /(\d{1,2})\s*(?:рок(?:и|ів)?|рік|лет|years?)/ig;
  let bestByKeyword = null;
  let bestByExperienceContext = null;

  for (const line of lines) {
    const normalizedLine = normalizeForCompare(line);
    const rawLine = normalizeKey(line);
    const looksLikeAgeLine = /,\s*\d{1,3}\s*рок(?:ів|и)?\b/i.test(rawLine) || /вік\s*:?\s*\d{1,3}/i.test(rawLine);
    const looksLikeExperienceLine = /^\*\s*/.test(line) || /досвід|experience|стаж/i.test(rawLine);

    if (looksLikeAgeLine && !looksLikeExperienceLine) continue;

    const hasPosition = keywords.length
      ? keywords.some((token) => normalizedLine.includes(token))
      : true;

    yearsRe.lastIndex = 0;
    let match;
    while ((match = yearsRe.exec(rawLine))) {
      const years = Number(match[1]);
      if (!Number.isFinite(years)) continue;

      if (hasPosition && (bestByKeyword === null || years > bestByKeyword)) {
        bestByKeyword = years;
      }

      if (looksLikeExperienceLine && (bestByExperienceContext === null || years > bestByExperienceContext)) {
        bestByExperienceContext = years;
      }
    }
  }

  if (bestByKeyword !== null) return bestByKeyword;
  if (bestByExperienceContext !== null) return bestByExperienceContext;
  return null;
}

function cityInSectionText(sectionText, queryCity) {
  const query = clean(queryCity);
  const source = String(sectionText || '');
  if (!query || !source) return false;

  if (cityMatches(source, query)) {
    return true;
  }

  const chunks = source
    .split(/[,;\.\|]/g)
    .map(clean)
    .filter(Boolean);

  return chunks.some((chunk) => cityMatches(chunk, query));
}

function cityInReadyToWork(markdown, queryCity) {
  const text = String(markdown || '').replace(/\r/g, '');
  const readyMatch = text.match(/Готовий\s+працювати\s*:?\s*([^\n]+)/i);
  const cityMatch = text.match(/Місто\s+проживання\s*:?\s*([^\n]+)/i);

  if (readyMatch && cityMatches(readyMatch[1], queryCity)) {
    return true;
  }

  if (cityMatch && cityMatches(cityMatch[1], queryCity)) {
    return true;
  }

  return false;
}

function parseNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function splitMarkdownSections(markdown) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    if (/^## \[/.test(line)) {
      if (current) sections.push(current);
      current = { titleLine: line, body: [] };
      continue;
    }

    if (current) {
      current.body.push(line);
    }
  }

  if (current) sections.push(current);
  return sections;
}

function extractLinkFromTitleLine(line) {
  const match = line.match(/^## \[(?<title>.*?)\]\((?<url>https?:\/\/[^)\s]+)(?:\s+".*?")?\)/);
  if (!match) return { title: '', url: '' };
  return { title: clean(match.groups.title), url: clean(match.groups.url) };
}

function parseResumePage(markdown, fallback) {
  const text = String(markdown || '').replace(/\r/g, '');
  const body = text
    .replace(/^Title:.*$/gm, '')
    .replace(/^URL Source:.*$/gm, '')
    .replace(/^Markdown Content:$/gm, '')
    .trim();

  const headings = Array.from(body.matchAll(/^##\s+(.+)$/gm)).map((match) => clean(match[1]));
  const lines = body
    .split('\n')
    .map((line) => clean(line.replace(/^[#*\-\s]+/, '')))
    .filter(Boolean);

  const name = headings[0] || fallback.name || '';
  const position = headings[1] || fallback.position || '';
  const age = clean((body.match(/Вік\s*:?\s*(\d{1,3})\s*рок/i) || [])[1]) || parseAgeFromBirthDate(body) || fallback.age || '';
  const cityMatch = body.match(/Місто\s+проживання\s*:?\s*([^\n]+)/i) || body.match(/Місто\s+([^\n]+)/i);
  const employmentMatch = body.match(/Вид\s+зайнятості\s*:?\s*([^\n]+)/i) || body.match(/(Повна(?:,\s*неповна)?\s+зайнятість|Неповна\s+зайнятість|Віддалена\s+робота|Дистанційно)/i);

  const fallbackPosition = lines.find((line) => !/^Резюме від/i.test(line) && line !== name) || '';

  return {
    name: clean(name),
    age: clean(age),
    city: clean(cityMatch?.[1] || fallback.city || ''),
    employmentType: clean(employmentMatch?.[1] || fallback.employmentType || ''),
    position: clean(position || fallbackPosition),
    photo: buildAvatarUrl(name || fallback.name || position, position || fallback.position),
    resumeUrl: fallback.resumeUrl,
    experienceYears: fallback.experienceYears,
    source: fallback.source
  };
}

async function fetchText(url, timeoutMs) {
  const response = await axios.get(url, {
    timeout: timeoutMs,
    responseType: 'text',
    validateStatus: (status) => status >= 200 && status < 500
  });

  return String(response.data || '');
}

async function fetchMirror(url, timeoutMs) {
  const target = url.replace(/^https?:\/\//i, '');
  return fetchText(`https://r.jina.ai/http://${target}`, timeoutMs);
}

function uniqueBy(items, keySelector) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keySelector(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildWorkUaSearchUrl(position, city) {
  const trimmedPosition = clean(position);
  const trimmedCity = clean(city);
  const phrase = [trimmedPosition, trimmedCity].filter(Boolean).join(' ');
  return `https://www.work.ua/resumes/?search=${encodeURIComponent(phrase || trimmedPosition)}`;
}

async function searchWorkUa({ position, city, employmentType, minExperienceYears, timeoutMs, limit }) {
  try {
    const searchUrl = buildWorkUaSearchUrl(position, city);
    const searchPage = await fetchMirror(searchUrl, timeoutMs);
    const sections = splitMarkdownSections(searchPage);

    const listCandidates = [];
    for (const section of sections.slice(0, limit * 12)) {
      const { title, url } = extractLinkFromTitleLine(section.titleLine);
      if (!url || !/work\.ua\/resumes\/\d+\//i.test(url)) continue;

      const searchCard = parseSearchCard(section.body.join('\n'));
      const sectionText = section.body.join(' ');
      if (!employmentMatches(searchCard.employmentType || sectionText, employmentType)) continue;

      let cityOk = cityMatches(searchCard.city, city) || cityInSectionText(sectionText, city);
      let detailedResumeText = '';

      if (!cityOk && clean(city)) {
        try {
          detailedResumeText = await fetchMirror(url, timeoutMs);
          cityOk = cityInReadyToWork(detailedResumeText, city);
        } catch {
          cityOk = false;
        }
      }

      if (!cityOk) continue;

      const experiencePositionHint = [title, position].filter(Boolean).join(' ');
      let experienceYears = extractExperienceYearsFromText(section.body.join('\n'), experiencePositionHint);
      if (experienceYears === null || (minExperienceYears !== null && experienceYears < minExperienceYears)) {
        if (!detailedResumeText) {
          try {
            detailedResumeText = await fetchMirror(url, timeoutMs);
          } catch {
            detailedResumeText = '';
          }
        }

        const fromResume = extractExperienceYearsFromText(detailedResumeText, experiencePositionHint);
        if (fromResume !== null) {
          experienceYears = fromResume;
        }
      }

      if (minExperienceYears !== null) {
        if (experienceYears === null || experienceYears < minExperienceYears) continue;
      }

      listCandidates.push({
        name: clean(searchCard.name || title),
        age: clean(searchCard.age || ''),
        city: clean(searchCard.city || ''),
        employmentType: clean(searchCard.employmentType || ''),
        experienceYears,
        position: clean(title || searchCard.name),
        photo: buildAvatarUrl(searchCard.name || title, title),
        resumeUrl: url,
        source: 'work.ua'
      });
    }

    const scored = uniqueBy(listCandidates, (item) => item.resumeUrl)
      .sort((a, b) => {
        const aExp = a.experienceYears === null ? -1 : a.experienceYears;
        const bExp = b.experienceYears === null ? -1 : b.experienceYears;
        return bExp - aExp;
      });

    return scored.slice(0, limit);
  } catch {
    return [];
  }
}

let robotaBrowserPromise = null;

function getRobotaBrowser() {
  if (!robotaBrowserPromise) {
    robotaBrowserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }).catch((error) => {
      robotaBrowserPromise = null;
      throw error;
    });
  }

  return robotaBrowserPromise;
}

async function closeRobotaBrowser() {
  if (!robotaBrowserPromise) return;

  try {
    const browser = await robotaBrowserPromise;
    await browser.close();
  } catch {
    // ignore
  } finally {
    robotaBrowserPromise = null;
  }
}

function buildRobotaUrl(position, city) {
  const positionPart = encodeURIComponent(clean(position) || 'кандидат');
  const cityPart = encodeURIComponent(clean(city) || 'ukraine');
  return `https://robota.ua/candidates/${positionPart}/${cityPart}`;
}

function parseRobotaCard(lines, href) {
  if (!lines.length) return null;

  const position = clean(lines[0]);
  const name = clean(lines[1] || '');
  const city = clean(lines[2] || '');
  let cursor = 3;

  let age = '';
  if (lines[cursor] && /\d+\s*(рок(?:и|ів)?|рік)(?![а-яіїєґ])/i.test(lines[cursor])) {
    age = clean((lines[cursor].match(/\d+/) || [])[0] || '');
    cursor += 1;
  }

  if (lines[cursor] && /(грн|\$|₴)/i.test(lines[cursor])) {
    cursor += 1;
  }

  let experienceYears = null;
  for (let i = cursor; i < lines.length; i += 1) {
    if (/^Остання активність/i.test(lines[i])) break;
    const match = lines[i].match(/(\d+)\s*(рок(?:и|ів)?|рік)(?![а-яіїєґ])/i);
    if (match) {
      experienceYears = Number(match[1]);
      break;
    }
  }

  const resumeId = (href.match(/\/candidates\/(\d+)/) || [])[1];
  if (!resumeId) return null;

  return {
    name: name || position,
    age,
    city,
    employmentType: '',
    experienceYears,
    position,
    photo: buildAvatarUrl(name || position, position),
    resumeUrl: `https://robota.ua${href}`,
    source: 'robota.ua'
  };
}

async function fetchRobotaUaCandidates({ position, city, timeoutMs, limit }) {
  let page;

  try {
    const browser = await getRobotaBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36');
    await page.goto(buildRobotaUrl(position, city), { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    try {
      await page.waitForSelector('a[href^="/candidates/"]', { timeout: Math.min(timeoutMs, 8000) });
    } catch {
      return [];
    }

    await new Promise((resolve) => setTimeout(resolve, 800));

    const rawCards = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href^="/candidates/"]'));
      return anchors
        .filter((a) => /^\/candidates\/\d+$/.test(a.getAttribute('href') || ''))
        .map((a) => ({
          href: a.getAttribute('href'),
          lines: a.innerText.split('\n').map((line) => line.trim()).filter(Boolean)
        }));
    });

    return rawCards
      .map((card) => parseRobotaCard(card.lines, card.href))
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

async function searchRobotaUa({ position, city, minExperienceYears, timeoutMs, limit }) {
  const candidates = await fetchRobotaUaCandidates({ position, city, timeoutMs, limit: Math.max(limit * 2, 10) });

  const filtered = minExperienceYears === null
    ? candidates
    : candidates.filter((candidate) => candidate.experienceYears !== null && candidate.experienceYears >= minExperienceYears);

  return uniqueBy(filtered, (item) => item.resumeUrl).slice(0, limit);
}

async function searchCandidates({ position, city, employmentType, minExperienceYears, timeoutMs = 20000, limit = 3 }) {
  const normalizedMinExperience = parseNumberOrNull(minExperienceYears);
  const [workUa, robotaUa] = await Promise.all([
    searchWorkUa({ position, city, employmentType, minExperienceYears: normalizedMinExperience, timeoutMs, limit: Math.max(limit * 2, 12) }),
    searchRobotaUa({ position, city, minExperienceYears: normalizedMinExperience, timeoutMs: Math.max(timeoutMs, 20000), limit })
  ]);

  const perSourceCap = Math.max(limit, 4);
  const combined = [...workUa.slice(0, perSourceCap), ...robotaUa.slice(0, perSourceCap)];

  return uniqueBy(combined, (item) => item.resumeUrl || `${item.source}:${item.name}:${item.position}`)
    .slice(0, Math.max(limit * 3, 12))
    .map((candidate) => ({
      name: clean(candidate.name || candidate.position || 'Кандидат'),
      age: clean(candidate.age || ''),
      photo: candidate.photo || buildAvatarUrl(candidate.name || candidate.position),
      position: clean(candidate.position || candidate.name || 'Не указана'),
      city: clean(candidate.city || city || ''),
      employmentType: clean(candidate.employmentType || employmentType || ''),
      experienceYears: candidate.experienceYears === null || candidate.experienceYears === undefined
        ? null
        : Number(candidate.experienceYears),
      resumeUrl: candidate.resumeUrl,
      source: candidate.source || ''
    }));
}

module.exports = {
  searchCandidates,
  closeRobotaBrowser
};