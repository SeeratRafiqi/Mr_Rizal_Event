function toDateOnly(dateObj) {
  return new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
}

function addDays(dateObj, days) {
  const d = new Date(dateObj);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isoDate(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

function todayISO(baseDate = new Date()) {
  return isoDate(toDateOnly(baseDate));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Short single-word signals use word boundaries so "ball" does not match "football". */
function hayContainsPhrase(hay, phrase) {
  const p = String(phrase).toLowerCase();
  if (!p.trim()) return false;
  if (p.length <= 4 && !/\s/.test(p)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRe(p)}([^a-z0-9]|$)`, 'i').test(hay);
  }
  return hay.includes(p);
}

function calculateNextDate(dayName, baseDate = new Date()) {
  const map = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  const target = map[String(dayName || '').toLowerCase()];
  if (target == null) return null;
  const today = toDateOnly(baseDate);
  const todayDay = today.getUTCDay();
  let offset = (target - todayDay + 7) % 7;
  if (offset === 0) offset = 7;
  return isoDate(addDays(today, offset));
}

function parseBudget(messageLower) {
  const maxMatch = messageLower.match(/(?:under|below|max|budget)\s*(?:rm)?\s*(\d+)/i);
  const maxPrice = maxMatch ? Number(maxMatch[1]) : null;

  const imFreeAvailability = /\b(i'?m|i am|im|we are|we're)\s+free\b/i.test(messageLower);
  const wantsFreeEvents =
    /\b(free\s+(event|events|show|shows|concert|concerts|festival|festivals|entry|admission|ticket|tickets))\b/i.test(messageLower) ||
    /\b(event|events|show|shows|ticket|tickets)\s+(that are|are)\s+free\b/i.test(messageLower) ||
    /\b(anything|something)\s+free\b/i.test(messageLower) ||
    /\bno\s+(cost|charge|fee|entry\s+fee)\b/i.test(messageLower) ||
    /\b(rm\s*0|0\s*rm)\b/i.test(messageLower);

  let type = 'any';
  const wantsCheap = messageLower.includes('cheap') || messageLower.includes('affordable');
  const casualFreePhrase = /\bfeel\s+free\b/i.test(messageLower);

  if (imFreeAvailability && !wantsFreeEvents) {
    type = 'any';
  } else if (wantsCheap) {
    type = 'cheap';
  } else if (wantsFreeEvents || (messageLower.includes('free') && !imFreeAvailability && !casualFreePhrase)) {
    type = 'free';
  }

  return { type, maxPrice };
}

function parseSpecificDateReference(messageLower, baseDate = new Date()) {
  const today = toDateOnly(baseDate);
  const monthMap = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
    april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
    august: 7, aug: 7, september: 8, sep: 8, sept: 8,
    october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  };

  const directIso = messageLower.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (directIso) {
    const y = Number(directIso[1]), m = Number(directIso[2]) - 1, d = Number(directIso[3]);
    const dt = new Date(Date.UTC(y, m, d));
    if (!Number.isNaN(dt.getTime()) && dt.getUTCMonth() === m && dt.getUTCDate() === d) return isoDate(dt);
  }

  const slashDate = messageLower.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](20\d{2}))?\b/);
  if (slashDate) {
    const day = Number(slashDate[1]), month = Number(slashDate[2]) - 1;
    let year = slashDate[3] ? Number(slashDate[3]) : today.getUTCFullYear();
    let dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== month || dt.getUTCDate() !== day) return null;
    if (!slashDate[3] && dt < today) { year += 1; dt = new Date(Date.UTC(year, month, day)); }
    return isoDate(dt);
  }

  const dayMonth = messageLower.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?!of\b)([a-z]+)(?:\s+(20\d{2}))?\b/,
  );
  if (dayMonth) {
    const day = Number(dayMonth[1]), month = monthMap[dayMonth[2]];
    if (month == null) return null;
    let year = dayMonth[3] ? Number(dayMonth[3]) : today.getUTCFullYear();
    let dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== month || dt.getUTCDate() !== day) return null;
    if (!dayMonth[3] && dt < today) { year += 1; dt = new Date(Date.UTC(year, month, day)); }
    return isoDate(dt);
  }

  const dayOfMonth = messageLower.match(
    /\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+of\s+([a-z]+)(?:\s+(20\d{2}))?\b/,
  );
  if (dayOfMonth) {
    const day = Number(dayOfMonth[1]);
    const month = monthMap[dayOfMonth[2]];
    if (month == null) return null;
    let year = dayOfMonth[3] ? Number(dayOfMonth[3]) : today.getUTCFullYear();
    let dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== month || dt.getUTCDate() !== day) return null;
    if (!dayOfMonth[3] && dt < today) {
      year += 1;
      dt = new Date(Date.UTC(year, month, day));
    }
    return isoDate(dt);
  }

  const monthDay = messageLower.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(20\d{2}))?\b/);
  if (monthDay) {
    const month = monthMap[monthDay[1]];
    if (month == null) return null;
    const day = Number(monthDay[2]);
    let year = monthDay[3] ? Number(monthDay[3]) : today.getUTCFullYear();
    let dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== month || dt.getUTCDate() !== day) return null;
    if (!monthDay[3] && dt < today) { year += 1; dt = new Date(Date.UTC(year, month, day)); }
    return isoDate(dt);
  }

  return null;
}

// FIX: "may" as auxiliary verb ("may I", "it may", "that may") must NOT be parsed as
// the month May.  Require a temporal preposition before it, or a 4-digit year after it.
function parseMonthReference(messageLower, baseDate = new Date()) {
  const monthMap = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
    april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
    august: 7, aug: 7, september: 8, sep: 8, sept: 8,
    october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  };

  // Non-"may" months: temporal preposition is optional (same as before)
  const nonMayRe =
    /\b(?:in|on|for|during|about|around|this|next)?\s*(january|jan|february|feb|march|mar|april|apr|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)(?:\s+(20\d{2}))?\b/i;

  // "may" only qualifies as a month when preceded by a temporal preposition OR followed by a year
  const mayRe =
    /\b(?:(?:in|on|for|during|about|around|this|next)\s+may|may\s+20\d{2})\b/i;

  let monthToken, yearStr;

  const nonMayMatch = nonMayRe.exec(messageLower);
  if (nonMayMatch) {
    monthToken = String(nonMayMatch[1] || '').toLowerCase();
    yearStr = nonMayMatch[2] || null;
  } else if (mayRe.test(messageLower)) {
    monthToken = 'may';
    const mayYearMatch = messageLower.match(/\bmay\s+(20\d{2})\b/i);
    yearStr = mayYearMatch ? mayYearMatch[1] : null;
  } else {
    return null;
  }

  const month = monthMap[monthToken];
  if (month == null) return null;

  const today = toDateOnly(baseDate);
  let year = yearStr ? Number(yearStr) : today.getUTCFullYear();
  if (!yearStr && month < today.getUTCMonth()) year += 1;

  const dates = [];
  const cursor = new Date(Date.UTC(year, month, 1));
  while (cursor.getUTCMonth() === month) {
    dates.push(isoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (!dates.length) return null;

  return { type: 'month', label: `${monthToken} ${year}`, dates };
}

/**
 * "Last week of April" = final 7 calendar days of that month (not the whole month, not "past week" retrospect).
 */
function parseLastWeekOfMonthReference(messageLower, baseDate = new Date()) {
  const monthMap = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
    april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
    august: 7, aug: 7, september: 8, sep: 8, sept: 8,
    october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  };
  const re =
    /\b(?:the\s+)?last\s+week\s+of\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)(?:\s+(20\d{2}))?\b/i;
  const m = messageLower.match(re);
  if (!m) return null;
  const monthToken = String(m[1] || '').toLowerCase();
  const month = monthMap[monthToken];
  if (month == null) return null;

  const today = toDateOnly(baseDate);
  let year = m[2] ? Number(m[2]) : today.getUTCFullYear();
  if (!m[2] && month < today.getUTCMonth()) year += 1;

  const lastDayNum = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dates = [];
  const startDay = Math.max(1, lastDayNum - 6);
  for (let d = startDay; d <= lastDayNum; d += 1) {
    dates.push(isoDate(new Date(Date.UTC(year, month, d))));
  }
  return { type: 'last_week_of_month', label: `last week of ${monthToken} ${year}`, dates };
}

function weekendSatSunFromOffset(today, satOffsetDays) {
  const sat = addDays(today, satOffsetDays);
  return [isoDate(sat), isoDate(addDays(sat, 1))];
}

function nextSaturdayFrom(today) {
  const day = today.getUTCDay();
  const off = (6 - day + 7) % 7;
  if (off === 0) return today;
  return addDays(today, off);
}

function parseDayReference(messageLower, baseDate = new Date()) {
  const today = toDateOnly(baseDate);

  const specificDate = parseSpecificDateReference(messageLower, baseDate);
  if (specificDate) return { type: 'specific_date', label: specificDate, dates: [specificDate] };

  const lastWeekOfMonth = parseLastWeekOfMonthReference(messageLower, baseDate);
  if (lastWeekOfMonth) return lastWeekOfMonth;

  const monthRef = parseMonthReference(messageLower, baseDate);
  if (monthRef) return monthRef;

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const day of weekdays) {
    if (new RegExp(`\\b${day}\\b`, 'i').test(messageLower)) {
      const date = calculateNextDate(day, baseDate);
      return { type: 'weekday', label: day, dates: date ? [date] : [] };
    }
  }

  if (/\b(tomorrow|tommorow|tommorrow)\b/i.test(messageLower))
    return { type: 'tomorrow', label: 'tomorrow', dates: [isoDate(addDays(today, 1))] };
  if (/\btonight\b/i.test(messageLower))
    return { type: 'tonight', label: 'tonight', dates: [isoDate(today)] };
  if (/\btoday\b/i.test(messageLower))
    return { type: 'today', label: 'today', dates: [isoDate(today)] };

  if (/\bnext\s+weekend\b/i.test(messageLower)) {
    const thisSat = nextSaturdayFrom(today);
    const offToThisSat = Math.round((thisSat - today) / 86400000);
    // FIX: "next weekend" = the weekend AFTER the upcoming one (always +7 days beyond this Sat)
    const nextSatOff = offToThisSat === 0 ? 7 : offToThisSat + 7;
    return { type: 'next_weekend', label: 'next weekend', dates: weekendSatSunFromOffset(today, nextSatOff) };
  }

  if (/\b(weekends?|this\s+weekends?|coming\s+weekends?|upcoming\s+weekends?)\b/i.test(messageLower)) {
    const thisSat = nextSaturdayFrom(today);
    const off = Math.round((thisSat - today) / 86400000);
    return { type: 'weekend', label: 'this weekend', dates: weekendSatSunFromOffset(today, off) };
  }

  if (/\bnext week\b/i.test(messageLower)) {
    const start = addDays(today, 7);
    const dates = [];
    for (let i = 0; i < 7; i++) dates.push(isoDate(addDays(start, i)));
    return { type: 'next_week', label: 'next week', dates };
  }

  // FIX: handle "next month" and "this month"
  if (/\bnext\s+month\b/i.test(messageLower)) {
    const nm = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    const dates = [];
    const cursor = new Date(nm);
    while (cursor.getUTCMonth() === nm.getUTCMonth()) {
      dates.push(isoDate(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return { type: 'next_month', label: 'next month', dates };
  }

  if (/\bthis\s+month\b/i.test(messageLower)) {
    const dates = [];
    const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const month = cursor.getUTCMonth();
    while (cursor.getUTCMonth() === month) {
      dates.push(isoDate(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return { type: 'this_month', label: 'this month', dates };
  }

  return { type: 'any', label: 'any time', dates: [] };
}

/** If user says "5 May or around", widen a single parsed day to ±2 calendar days. */
function expandDayIfApproximate(dayRef, messageLower) {
  if (!dayRef || dayRef.type !== 'specific_date' || !dayRef.dates || dayRef.dates.length !== 1) {
    return dayRef;
  }
  if (!/\b(around|about|roughly|or thereabouts|give or take|or so)\b/i.test(messageLower)) {
    return dayRef;
  }
  const centerStr = dayRef.dates[0];
  const parts = centerStr.split('-').map(Number);
  const y = parts[0];
  const mo = parts[1];
  const da = parts[2];
  const expanded = new Set();
  for (let delta = -2; delta <= 2; delta += 1) {
    const dt = new Date(Date.UTC(y, mo - 1, da + delta));
    expanded.add(isoDate(dt));
  }
  return {
    ...dayRef,
    dates: [...expanded].sort(),
    label: `${centerStr} (±2 days)`,
  };
}

/**
 * Substrings that count as a "match" for a mood token (events rarely use the exact word
 * "romantic" or "kids" in the title; they say "musical", "family", "all ages", etc.).
 */
const MOOD_SIGNALS = {
  romantic: [
    'romantic', 'romance', 'date night', 'couple', 'love', 'valentine', 'candlelight', 'anniversary',
    'wedding', 'gala ball', 'masquerade', 'musical', 'theatre', 'theater', 'broadway', 'disney', 'fairytale',
    'fairy tale', 'princess', 'opera', 'ballet', 'love story',
  ],
  family: [
    'family', 'kid', 'kids', 'child', 'children', 'toddler', 'parent', 'all ages', 'school holiday',
    'fun fair', 'carnival', 'disney', 'junior', 'suitable for children', 'family-friendly',
  ],
  kids: [
    'kid', 'kids', 'child', 'children', 'toddler', 'family', 'all ages', 'junior', 'youth', 'school',
    'disney', 'cartoon', 'storybook', 'puppet', 'belle', 'beast', 'fairytale',
  ],
  comedy: ['comedy', 'comic', 'stand up', 'standup', 'stand-up', 'improv', 'funny', 'humour', 'humor'],
  music: ['music', 'concert', 'band', 'dj', 'gig', 'live band', 'festival', 'symphony', 'orchestra', 'karaoke'],
  art: ['art', 'gallery', 'exhibition', 'museum', 'paint', 'craft', 'illustration'],
  chill: ['chill', 'laid back', 'laid-back', 'acoustic', 'cozy', 'cosy', 'lounge', 'cafe', 'coffee'],
  energetic: ['energetic', 'high energy', 'hype', 'edm', 'rave'],
  hype: ['hype', 'edm', 'rave', 'festival'],
  party: ['party', 'club', 'nightclub', 'celebration', 'gala'],
  workshop: ['workshop', 'masterclass', 'class', 'course', 'training'],
  outdoor: ['outdoor', 'hiking', 'park', 'run', 'marathon', 'cycling'],
  food: ['food', 'dining', 'buffet', 'tasting', 'wine', 'tea'],
  networking: ['networking', 'mixer', 'meetup', 'summit', 'conference', 'symposium'],
};

function eventMatchesMoodToken(hay, token) {
  const t = String(token || '').toLowerCase();
  const signals = MOOD_SIGNALS[t];
  if (signals && signals.length) return signals.some((s) => hayContainsPhrase(hay, s));
  return hayContainsPhrase(hay, t);
}

function parseMoodKeywords(messageLower) {
  const known = [
    'chill', 'romantic', 'energetic', 'hype', 'party', 'music', 'concert',
    'comedy', 'family', 'kids', 'workshop', 'art', 'outdoor', 'food', 'networking',
  ];
  const out = new Set(known.filter((m) => messageLower.includes(m)));
  if (
    /\b(child|children|toddler|kid-?friendly|family-?friendly|for kids|with (my )?kids|little ones)\b/i.test(
      messageLower,
    )
  ) {
    out.add('family');
    out.add('kids');
  }
  if (/\b(date night|couples?|anniversary|valentine)\b/i.test(messageLower)) {
    out.add('romantic');
  }
  return [...out];
}

function parsePlaceFilter(messageLower) {
  if (/\b(selangor|shah alam|petaling jaya|\bpj\b|subang|puchong|klang|gombak|ampang|rawang|cyberjaya|sepang|seri kembangan|bangi|kajang)\b/i.test(messageLower)) {
    return {
      mode: 'selangor',
      label: 'Selangor area',
      keywords: [
        'selangor', 'shah alam', 'petaling jaya', 'subang jaya', 'subang', 'puchong', 'klang',
        'gombak', 'ampang', 'rawang', 'cyberjaya', 'sepang', 'seri kembangan', 'bangi', 'kajang',
        'setia alam', 'damansara', 'usj', 'putra heights', 'ulu langat', 'kota damansara',
      ],
    };
  }
  if (/\b(kuala lumpur|\bkl\b|klcc|bukit bintang|mont kiara|cheras)\b/i.test(messageLower)) {
    return {
      mode: 'kl',
      label: 'Kuala Lumpur',
      keywords: [
        'kuala lumpur', 'klcc', 'bukit bintang', 'mont kiara', 'cheras',
        'sentul', 'wangsa maju', 'kepong', 'brickfields', 'mid valley', 'trx', 'bukit jalil',
        'titiwangsa', 'setapak',
      ],
    };
  }
  return { mode: 'any', label: '', keywords: [] };
}

function inferAudience(messageLower) {
  const graduation = /\bgraduation|graduate|convocation\b/i.test(messageLower);
  const friendsFun = /\b(friends?|mates?|squad|crew|buddy|buddies|group|celebrate|celebration)\b/i.test(messageLower);
  const adultSocial =
    /\b(night out|drinks?|bar|clubbing|club|happy hour|mixer|afterparty)\b/i.test(messageLower) ||
    (friendsFun && /\b(fun|party|night|hang)\b/i.test(messageLower));
  const wantsKids = /\b(kids?|children|toddler|baby|family with)\b/i.test(messageLower);
  return { graduation, friendsFun, adultSocial, wantsKids };
}

/**
 * Decide whether the latest message is REFINING the previous query (keep history context)
 * or starting a FRESH new query (drop history context).
 *
 * REFINEMENT examples — user is narrowing/adjusting the same search:
 *   "any under RM100?"         → adds price filter, no new topic
 *   "what about free ones?"    → adds free filter
 *   "how about comedy?"        → changes mood only
 *   "how about Saturday?"      → shifts date (continuation phrase + date, no new place)
 *   "any more?", "what else?"  → asking for more results
 *
 * NEW QUERY examples — user is asking something completely different:
 *   "are there any events on Wednesday?"   → new standalone date, no continuation phrase
 *   "events in Penang"                     → new place (even with "how about")
 *   "show me concerts next month"          → full new query structure
 *   "what about food festivals in KL?"     → new place always = new query
 *
 * Decision rules (in priority order):
 *  1. Message has a NEW PLACE            → always NEW  (place = strong topic reset)
 *  2. Only budget/mood changed           → always REFINE
 *  3. Continuation phrase + new date, no new place → REFINE ("how about Saturday?")
 *  4. New date, no continuation phrase   → NEW (standalone date query)
 *  5. Continuation phrase, no new filters → REFINE ("any more?", "what else?")
 *  6. Nothing new + no continuation      → NEW (fresh general query)
 */
function isRefinementQuery(message, history) {
  // Only meaningful when there's prior context to refine
  const hasHistory = Array.isArray(history) && history.some(
    (h) => h && h.role === 'user' && typeof h.content === 'string' && h.content.trim()
  );
  if (!hasHistory) return false;

  const lower = message.toLowerCase().trim();
  const intent = parseUserIntent(message);

  const hasNewDate  = intent.day?.type !== 'any';
  const hasNewPlace = intent.place?.mode !== 'any';
  const hasNewBudget = intent.budget?.type !== 'any' || Number.isFinite(intent.budget?.maxPrice);
  const hasNewMood  = Array.isArray(intent.mood) && intent.mood.length > 0;

  // Rule 1: new place is always a topic reset
  if (hasNewPlace) return false;

  // Detect continuation / refinement language
  const hasContinuationPhrase =
    /^(what about|how about|what if|any more|what else|show me (more|cheaper|other|different)|and\s+(what|how)\s+about|also|but\s+what|or\s+what)\b/i.test(lower) ||
    /^any\b/i.test(lower) ||
    /\b(instead|rather|alternatively|as well|too|also|more options?|other options?|what else|anything else|any more)\b/i.test(lower);

  // Rule 2: only budget/mood changed, no date or place → always refine
  if (!hasNewDate && (hasNewBudget || hasNewMood)) return true;

  // Rule 3: continuation phrase + new date but no new place → refine
  if (hasContinuationPhrase && hasNewDate) return true;

  // Rule 4: new date without continuation phrase → new query
  if (hasNewDate && !hasContinuationPhrase) return false;

  // Rule 5: continuation phrase, no new filters → refine ("any more?", "what else?")
  if (hasContinuationPhrase) return true;

  // Rule 6: no new anything, no continuation → new standalone query
  return false;
}

/** True when the user is explicitly asking about events that already happened (not generic "last chance"). */
function isAskingAboutPast(messageLower) {
  return (
    /\b(past\s+events?|events?\s+in\s+the\s+past|in\s+the\s+past|that (already )?happened)\b/i.test(messageLower) ||
    /\b(recently\s+ended|already\s+happened|what\s+happened|what\s+was|archive|missed|did\s+i\s+miss)\b/i.test(
      messageLower,
    ) ||
    /\b(previous\s+events?|retro|throwback|historic(al)?|nostalgia)\b/i.test(messageLower) ||
    /\blast\s+year\b/i.test(messageLower) ||
    (/\blast\s+month\b/i.test(messageLower) && !/\blast\s+month\s+of\b/i.test(messageLower)) ||
    (/\blast\s+week\b/i.test(messageLower) && !/\blast\s+week\s+of\b/i.test(messageLower)) ||
    (/\blast\s+weekend\b/i.test(messageLower) && !/\blast\s+weekend\s+of\b/i.test(messageLower)) ||
    /\blast\s+night\b/i.test(messageLower) ||
    /\byesterday'?s\b/i.test(messageLower) ||
    /\b(last\s+sun(day)?|last\s+mon(day)?|last\s+tue(sday)?|last\s+wed(nesday)?|last\s+thu(rsday)?|last\s+fri(day)?|last\s+sat(urday)?)\b/i.test(
      messageLower,
    ) ||
    /\bwhat did I miss\b/i.test(messageLower) ||
    /\b(yesterday'?s\s+events?|events?\s+(from\s+)?yesterday|shows?\s+yesterday)\b/i.test(messageLower)
  );
}

function parseUserIntent(message, baseDate = new Date()) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  let dayRef = parseDayReference(lower, baseDate);
  dayRef = expandDayIfApproximate(dayRef, lower);
  const placeRef = parsePlaceFilter(lower);
  const hasDateOrPlace = dayRef.type !== 'any' || placeRef.mode !== 'any';

  const hasExplicitEventWord =
    /\b(events?|shows?|concerts?|gigs?|festivals?|recommend|things to do|what'?s on|happening|plans?|weekend|tonight|tomorrow|suggest|ideas?|something fun|fun things|what to do|celebrate|graduation|birthday|hangout|outing|plan for)\b/i.test(lower);

  // FIX: "in KL" alone (no event keyword) should NOT trigger the expensive event pipeline
  const hasPlaceOnly = placeRef.mode !== 'any' && dayRef.type === 'any' && !hasExplicitEventWord;

  const vibeAsk =
    /\b(suggest|ideas?|something fun|fun things|what to do|celebrate|graduation|birthday|hangout|outing|plan for)\b/i.test(lower);

  const eventDiscovery =
    /\b(events?|shows?|concerts?|gigs?|festivals?|recommend|things to do|what'?s on|happening|plans?|weekend|tonight|tomorrow)\b/i.test(lower) ||
    vibeAsk ||
    (hasDateOrPlace && !hasPlaceOnly);

  const bookingHelp =
    /\b(how (do|to)|what is|explain|help|booking|book|tickets?|refund|payment|checkout|cancel|account|password|this app|the site|website)\b/i.test(lower);

  const isGeneralQuestion = bookingHelp && !eventDiscovery;
  const isEventRequest = !isGeneralQuestion && eventDiscovery;

  const askingAboutPast = isAskingAboutPast(lower);

  return {
    isEventRequest,
    isGeneralQuestion,
    askingAboutPast,
    budget: parseBudget(lower),
    mood: parseMoodKeywords(lower),
    day: dayRef,
    place: placeRef,
    audience: inferAudience(lower),
    query: text,
  };
}

function eventDateISO(event) {
  const raw = String(event?.date || '').trim();
  if (!raw) return null;
  const direct = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// FIX: only compare price numbers when currency is MYR; skip USD/SGD/etc. to avoid
// incorrect currency cross-comparisons (e.g. USD 60 failing an RM 50 filter).
function parsePriceNumber(event) {
  if (event.isFree) return 0;
  const txt = `${event.price || ''}`.toUpperCase();
  if (/\b(USD|SGD|THB|IDR|PHP)\b/.test(txt)) return null; // foreign currency — skip comparison
  const m = txt.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// FIX: treat "0.00 MYR", "0.00 USD", "Free", "RM0" etc. as free even if isFree flag is false
function isEventFree(event) {
  if (event.isFree) return true;
  const txt = `${event.price || ''}`.trim();
  if (!txt) return false;
  if (/^(free|rm\s*0|0\.00(\s*(myr|usd|sgd))?|0\s*(myr|usd)?)$/i.test(txt)) return true;
  const n = parsePriceNumber(event);
  return n === 0;
}

function eventHaystack(event) {
  return `${event.title || ''} ${event.venue || ''} ${event.city || ''} ${event.category || ''} ${event.summary || ''}`.toLowerCase();
}

function matchesPlace(hay, place) {
  if (place.mode === 'any') return true;
  if (place.mode === 'selangor' && /\bpj\b/.test(hay)) return true;
  return place.keywords.some((kw) => {
    const k = kw.trim().toLowerCase();
    return k && hay.includes(k);
  });
}

function audienceScoreAdjust(hay, audience) {
  let adj = 0;
  const kidHeavy = /\b(kids?|children|toddler|baby|cocomelon|playground|kindy|nursery|school trip|family fun day)\b/i.test(hay);
  const adultLean = /\b(concert|comedy|nightclub|club|bar|mixer|networking|festival|dj|live band|stand[- ]?up|party|gala|dinner)\b/i.test(hay);
  if ((audience.adultSocial || audience.graduation || audience.friendsFun) && !audience.wantsKids) {
    if (kidHeavy) adj -= 120;
    if (audience.graduation && adultLean) adj += 25;
    if (audience.friendsFun && adultLean) adj += 20;
    if (audience.graduation && /\b(celebrat|party|dinner|gala|night)\b/i.test(hay)) adj += 15;
  }
  if (audience.wantsKids && kidHeavy) adj += 40;
  return adj;
}

function moodScore(hay, mood) {
  if (!mood.length) return 0;
  let hits = 0;
  for (const m of mood) {
    if (eventMatchesMoodToken(hay, m)) hits += 1;
  }
  return (hits / mood.length) * 40;
}

function eventSourceKey(event) {
  return String(event?.source || event?._source || 'unknown').toLowerCase();
}

function isPlaceholderVenueText(venue) {
  const v = String(venue || '').trim().toLowerCase();
  if (!v) return true;
  if (/^(tba|tbd|tbh|n\/a|none|[?])$/i.test(v)) return true;
  if (/^(to be announced|to be confirmed|venue tba|location tba)\b/i.test(v)) return true;
  if (/\b(tba|tbd|tbh)\b$/i.test(v)) return true;
  return false;
}

/** Legacy DB rows: hide Ticketmelon listings that are clearly not priced in MYR/RM. */
function ticketmelonStrictCatalog(event) {
  if (eventSourceKey(event) !== 'ticketmelon') return true;
  const p = String(event.price || '').trim();
  if (/\b(THB|SGD|PHP|IDR|USD|VND|EUR|AUD|GBP|HKD|TWD|JPY|KRW|CNY)\b/i.test(p)) return false;
  if (isEventFree(event)) return true;
  if (!p) return false;
  if (/^free$/i.test(p) || /\b(myr|rm)\b/i.test(p)) return true;
  return false;
}

/** Slight boost so RAG ordering is not dominated by one platform; Ticketmelon is not boosted (often floods vector hits). */
function sourceDiversityBoost(event) {
  const s = eventSourceKey(event);
  if (s === 'ticket2u' || s === 'goliveasia') return 4;
  if (s === 'peatix') return 3;
  if (s === 'eventbrite') return 2;
  if (s === 'ticketmelon') return 0;
  return 1;
}

function rankEvents(events, intent) {
  return events
    .map((event) => {
      const hay = eventHaystack(event);
      let score = 50 + moodScore(hay, intent.mood || []);
      score += audienceScoreAdjust(hay, intent.audience || {});
      if (isEventFree(event) && intent.budget?.type === 'free') score += 15;
      score += sourceDiversityBoost(event);
      return { event, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.event);
}

function normalizeUrlForDedupe(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
    const u = new URL(withProto);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}`.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\s+/g, '');
  }
}

/** Drop duplicate listings (same URL, or same source+title+date without URL). */
function dedupeEventsForRecommendations(events) {
  if (!Array.isArray(events) || !events.length) return [];
  const seenUrl = new Set();
  const seenLoose = new Set();
  const out = [];
  for (const e of events) {
    const nu = normalizeUrlForDedupe(e.url || '');
    if (nu) {
      if (seenUrl.has(nu)) continue;
      seenUrl.add(nu);
      out.push(e);
      continue;
    }
    const loose = `${eventSourceKey(e)}|${String(e.title || '')
      .toLowerCase()
      .slice(0, 96)}|${eventDateISO(e) || ''}`;
    if (seenLoose.has(loose)) continue;
    seenLoose.add(loose);
    out.push(e);
  }
  return out;
}

/**
 * Re-order so multiple sources appear in recommendations (round-robin by source),
 * while roughly preserving relevance order inside each source bucket.
 * @param {object} [options] - optional maxPerSource caps, preferredOrder, backfillUncapped
 */
function diversifyBySource(events, limit = 15, options = {}) {
  if (!Array.isArray(events) || !events.length) return [];
  const preferredOrder =
    options.preferredOrder || ['ticket2u', 'goliveasia', 'eventbrite', 'peatix', 'ticketmelon'];
  const maxPerSource = options.maxPerSource && typeof options.maxPerSource === 'object' ? options.maxPerSource : null;
  const buckets = new Map();
  for (const ev of events) {
    const k = eventSourceKey(ev);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(ev);
  }
  const keys = [
    ...preferredOrder.filter((k) => buckets.has(k)),
    ...[...buckets.keys()].filter((k) => !preferredOrder.includes(k)),
  ];
  const out = [];
  const used = new Map();
  let stagnant = 0;
  const capStagnant = maxPerSource ? keys.length + 10 : keys.length + 2;

  while (out.length < limit && stagnant < capStagnant) {
    let progressed = false;
    for (const k of keys) {
      if (maxPerSource && Object.prototype.hasOwnProperty.call(maxPerSource, k)) {
        if ((used.get(k) || 0) >= maxPerSource[k]) continue;
      }
      const arr = buckets.get(k);
      if (arr?.length && out.length < limit) {
        out.push(arr.shift());
        used.set(k, (used.get(k) || 0) + 1);
        progressed = true;
      }
    }
    if (!progressed) stagnant += 1;
    else stagnant = 0;
  }

  if (out.length < limit && maxPerSource) {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(maxPerSource, k)) continue;
      const arr = buckets.get(k);
      while (arr?.length && out.length < limit) {
        out.push(arr.shift());
      }
    }
  }

  return out;
}

function eventIdentityKey(e) {
  const u = normalizeUrlForDedupe(e.url || '');
  if (u) return `u:${u}`;
  return `k:${eventSourceKey(e)}|${String(e.title || '')
    .toLowerCase()
    .slice(0, 96)}|${eventDateISO(e) || ''}`;
}

/**
 * Upcoming-only: must have a parseable date on or after today.
 * Undated rows cannot be proven future — excluded from discovery/recommendations.
 */
function filterFutureEvents(events, baseDate = new Date()) {
  if (!Array.isArray(events) || !events.length) return [];
  const todayStr = todayISO(baseDate);
  return events.filter((e) => {
    const ed = eventDateISO(e);
    return ed != null && ed >= todayStr;
  });
}

function countBySourceInList(list) {
  const c = {};
  for (const e of list) {
    const s = eventSourceKey(e);
    c[s] = (c[s] || 0) + 1;
  }
  return c;
}

/**
 * When vector search returns one source only, merge in upcoming events from the full catalog
 * so ranking/diversification has Eventbrite, Ticket2U, etc. to choose from.
 */
function mergeRagPoolForSourceDiversity(ragEvents, catalogFutureDeduped, opts = {}) {
  const maxPool = opts.maxPool ?? 80;
  const floorPerSource = opts.floorPerSource ?? 4;
  const prioritySources = ['eventbrite', 'ticket2u', 'goliveasia', 'peatix', 'ticketmelon'];

  const seen = new Set();
  const out = [];
  function add(e) {
    if (!e) return false;
    const k = eventIdentityKey(e);
    if (seen.has(k)) return false;
    seen.add(k);
    out.push(e);
    return true;
  }

  for (const e of ragEvents) {
    add(e);
    if (out.length >= maxPool) return out;
  }

  const catalogBy = new Map();
  for (const s of prioritySources) catalogBy.set(s, []);
  const otherKey = '_other';
  catalogBy.set(otherKey, []);
  for (const e of catalogFutureDeduped) {
    const s = eventSourceKey(e);
    if (catalogBy.has(s)) catalogBy.get(s).push(e);
    else catalogBy.get(otherKey).push(e);
  }

  for (const s of prioritySources) {
    const arr = catalogBy.get(s);
    while (out.length < maxPool && arr.length) {
      const c = countBySourceInList(out);
      if ((c[s] || 0) >= floorPerSource) break;
      add(arr.shift());
    }
  }

  let guard = 0;
  while (out.length < maxPool && guard < prioritySources.length * 400) {
    guard += 1;
    let progressed = false;
    for (const s of prioritySources) {
      if (out.length >= maxPool) break;
      const arr = catalogBy.get(s);
      if (!arr.length) continue;
      if (add(arr.shift())) progressed = true;
    }
    if (!progressed) break;
  }

  const rest = catalogBy.get(otherKey);
  while (out.length < maxPool && rest.length) {
    if (!add(rest.shift())) break;
  }

  return out;
}

function poolNeedsSourceBlend(pool) {
  if (!Array.isArray(pool) || pool.length < 8) return true;
  const c = countBySourceInList(pool);
  const keys = Object.keys(c);
  if (keys.length < 2) return true;
  const maxShare = Math.max(...Object.values(c)) / pool.length;
  return maxShare > 0.42;
}

function selectDiverseRecommendations(pool, intent, limit = 15) {
  if (!Array.isArray(pool) || !pool.length) return [];
  if (!(intent && intent.askingAboutPast === true)) {
    pool = filterFutureEvents(pool);
  }
  pool = pool.filter((e) => {
    if (eventSourceKey(e) !== 'ticketmelon') return true;
    return ticketmelonStrictCatalog(e) && !isPlaceholderVenueText(e.venue);
  });
  if (!pool.length) return [];
  const ranked = rankEvents(pool, intent || {});
  const breadth = Math.min(Math.max(limit * 5, 50), ranked.length);
  const slice = ranked.slice(0, breadth);
  const divOpts = {
    maxPerSource: { ticketmelon: 3 },
    preferredOrder: ['ticket2u', 'goliveasia', 'eventbrite', 'peatix', 'ticketmelon'],
  };
  return diversifyBySource(slice, limit, divOpts);
}

function pickWeekendBalanced(ranked, intent, limit) {
  const dates = intent.day?.dates || [];
  if (dates.length < 2) return ranked.slice(0, limit);
  const [sat, sun] = dates;
  const satList = ranked.filter((e) => eventDateISO(e) === sat);
  const sunList = ranked.filter((e) => eventDateISO(e) === sun);
  const out = [];
  let i = 0;
  while (out.length < limit && (satList.length || sunList.length)) {
    if (i % 2 === 0 && satList.length) out.push(satList.shift());
    else if (i % 2 === 1 && sunList.length) out.push(sunList.shift());
    else if (satList.length) out.push(satList.shift());
    else if (sunList.length) out.push(sunList.shift());
    i++;
  }
  return out;
}

function filterEventsByPreferences(events, preferences, baseDate = new Date()) {
  const mood = Array.isArray(preferences?.mood) ? preferences.mood : [];
  const dayDates = new Set(preferences?.day?.dates || []);
  const hasDateFilter = dayDates.size > 0;
  const budget = preferences?.budget || { type: 'any', maxPrice: null };
  const place = preferences?.place || { mode: 'any', keywords: [] };
  const hasPlaceFilter = place.mode !== 'any';

  // FIX: unless the user is specifically asking about past events, filter out events
  // that have already passed (date < today).
  const askingAboutPast = preferences?.askingAboutPast === true;
  const todayStr = todayISO(baseDate);

  let out = events.filter((event) => {
    const ed = eventDateISO(event);

    // --- Past / upcoming filter ---
    if (!askingAboutPast) {
      if (hasDateFilter) {
        if (!ed || !dayDates.has(ed)) return false;
        // Named a calendar day: never return that day if it is already in the past
        if (ed < todayStr) return false;
      } else {
        // Suggestions / open-ended: only events we can date as today or later
        if (!ed || ed < todayStr) return false;
      }
    } else {
      // Asking about past: still apply date filter if present
      if (hasDateFilter && (!ed || !dayDates.has(ed))) return false;
    }

    // FIX: use isEventFree() so "0.00 MYR" events pass the free filter
    if (budget.type === 'free' && !isEventFree(event)) return false;

    // FIX: parsePriceNumber now returns null for foreign currencies, so cross-currency
    // comparisons are skipped cleanly (Number.isFinite(null) === false)
    const eventPrice = parsePriceNumber(event);
    if (Number.isFinite(budget.maxPrice) && Number.isFinite(eventPrice) && eventPrice > budget.maxPrice) {
      return false;
    }

    if (mood.length) {
      const hay = `${event.title || ''} ${event.category || ''} ${event.summary || ''} ${event.venue || ''} ${
        event.city || ''
      }`.toLowerCase();
      if (!mood.some((token) => eventMatchesMoodToken(hay, token))) return false;
    }

    if (hasPlaceFilter && !matchesPlace(eventHaystack(event), place)) return false;

    if (eventSourceKey(event) === 'ticketmelon' && !ticketmelonStrictCatalog(event)) return false;

    if (eventSourceKey(event) === 'ticketmelon' && isPlaceholderVenueText(event.venue)) return false;

    return true;
  });

  out = dedupeEventsForRecommendations(out);
  const ranked = rankEvents(out, preferences);
  const limit = 15;
  let picked;
  if (preferences?.day?.type === 'weekend' || preferences?.day?.type === 'next_weekend') {
    picked = pickWeekendBalanced(ranked, preferences, limit);
  } else {
    picked = ranked.slice(0, limit);
  }
  return diversifyBySource(picked, limit, {
    maxPerSource: { ticketmelon: 3 },
    preferredOrder: ['ticket2u', 'goliveasia', 'eventbrite', 'peatix', 'ticketmelon'],
  });
}

/**
 * Build context string for intent parsing from recent history.
 *
 * FIX (multi-turn context bleed): Reduced history window from 4 → 3 user turns and
 * capped at 2000 chars (was 4000).  This prevents stale filters from early messages
 * contaminating later, unrelated queries after 2-3 conversation turns.
 */
function buildIntentContext(message, history) {
  if (!Array.isArray(history) || !history.length) return message;
  const userLines = history
    .filter((h) => h && h.role === 'user' && typeof h.content === 'string')
    .map((h) => h.content.trim())
    .slice(-3); // was -4; reduced to limit stale-context accumulation
  const combined = [...userLines, message].filter(Boolean).join(' \n ');
  return combined.slice(-2000); // was -4000
}

module.exports = {
  calculateNextDate,
  parseUserIntent,
  filterEventsByPreferences,
  buildIntentContext,
  isRefinementQuery,
  isEventFree,
  eventDateISO,
  todayISO,
  dedupeEventsForRecommendations,
  diversifyBySource,
  filterFutureEvents,
  mergeRagPoolForSourceDiversity,
  poolNeedsSourceBlend,
  selectDiverseRecommendations,
};