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

function calculateNextDate(dayName, baseDate = new Date()) {
  const map = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
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

  /** "I'm free tomorrow" = availability, not "free entry" events */
  const imFreeAvailability = /\b(i'?m|i am|im|we are|we're)\s+free\b/i.test(messageLower);
  const wantsFreeEvents =
    /\b(free\s+(event|events|show|shows|concert|concerts|festival|festivals|entry|admission|ticket|tickets))\b/i.test(
      messageLower,
    ) ||
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
  } else if (
    wantsFreeEvents ||
    (messageLower.includes('free') && !imFreeAvailability && !casualFreePhrase)
  ) {
    type = 'free';
  }

  return { type, maxPrice };
}

function parseSpecificDateReference(messageLower, baseDate = new Date()) {
  const today = toDateOnly(baseDate);
  const monthMap = {
    january: 0, jan: 0,
    february: 1, feb: 1,
    march: 2, mar: 2,
    april: 3, apr: 3,
    may: 4,
    june: 5, jun: 5,
    july: 6, jul: 6,
    august: 7, aug: 7,
    september: 8, sep: 8, sept: 8,
    october: 9, oct: 9,
    november: 10, nov: 10,
    december: 11, dec: 11,
  };

  const directIso = messageLower.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (directIso) {
    const y = Number(directIso[1]);
    const m = Number(directIso[2]) - 1;
    const d = Number(directIso[3]);
    const dt = new Date(Date.UTC(y, m, d));
    if (!Number.isNaN(dt.getTime()) && dt.getUTCMonth() === m && dt.getUTCDate() === d) {
      return isoDate(dt);
    }
  }

  const slashDate = messageLower.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](20\d{2}))?\b/);
  if (slashDate) {
    const day = Number(slashDate[1]);
    const month = Number(slashDate[2]) - 1;
    let year = slashDate[3] ? Number(slashDate[3]) : today.getUTCFullYear();
    let dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== month || dt.getUTCDate() !== day) return null;
    if (!slashDate[3] && dt < today) {
      year += 1;
      dt = new Date(Date.UTC(year, month, day));
    }
    return isoDate(dt);
  }

  const dayMonth = messageLower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(20\d{2}))?\b/);
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = monthMap[dayMonth[2]];
    if (month == null) return null;
    let year = dayMonth[3] ? Number(dayMonth[3]) : today.getUTCFullYear();
    let dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== month || dt.getUTCDate() !== day) return null;
    if (!dayMonth[3] && dt < today) {
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
    if (!monthDay[3] && dt < today) {
      year += 1;
      dt = new Date(Date.UTC(year, month, day));
    }
    return isoDate(dt);
  }

  return null;
}

function parseMonthReference(messageLower, baseDate = new Date()) {
  const monthMap = {
    january: 0, jan: 0,
    february: 1, feb: 1,
    march: 2, mar: 2,
    april: 3, apr: 3,
    may: 4,
    june: 5, jun: 5,
    july: 6, jul: 6,
    august: 7, aug: 7,
    september: 8, sep: 8, sept: 8,
    october: 9, oct: 9,
    november: 10, nov: 10,
    december: 11, dec: 11,
  };

  const m = messageLower.match(
    /\b(?:in|on|for|during|about|around|this|next)?\s*(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)(?:\s+(20\d{2}))?\b/i,
  );
  if (!m) return null;

  const monthToken = String(m[1] || '').toLowerCase();
  const month = monthMap[monthToken];
  if (month == null) return null;

  const today = toDateOnly(baseDate);
  let year = m[2] ? Number(m[2]) : today.getUTCFullYear();
  if (!m[2] && month < today.getUTCMonth()) {
    year += 1;
  }

  const dates = [];
  const cursor = new Date(Date.UTC(year, month, 1));
  while (cursor.getUTCMonth() === month) {
    dates.push(isoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (!dates.length) return null;

  return {
    type: 'month',
    label: `${monthToken} ${year}`,
    dates,
  };
}

function weekendSatSunFromOffset(today, satOffsetDays) {
  const sat = addDays(today, satOffsetDays);
  const sun = addDays(sat, 1);
  return [isoDate(sat), isoDate(sun)];
}

/** Next Saturday from `today` (strictly in the future unless `today` is Saturday). */
function nextSaturdayFrom(today) {
  const day = today.getUTCDay();
  let off = (6 - day + 7) % 7;
  if (off === 0) return today;
  return addDays(today, off);
}

function parseDayReference(messageLower, baseDate = new Date()) {
  const today = toDateOnly(baseDate);
  const specificDate = parseSpecificDateReference(messageLower, baseDate);
  if (specificDate) {
    return { type: 'specific_date', label: specificDate, dates: [specificDate] };
  }
  const monthRef = parseMonthReference(messageLower, baseDate);
  if (monthRef) return monthRef;

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const day of weekdays) {
    if (new RegExp(`\\b${day}\\b`, 'i').test(messageLower)) {
      const date = calculateNextDate(day, baseDate);
      return { type: 'weekday', label: day, dates: date ? [date] : [] };
    }
  }

  if (/\b(tomorrow|tommorow|tommorrow)\b/i.test(messageLower)) {
    return { type: 'tomorrow', label: 'tomorrow', dates: [isoDate(addDays(today, 1))] };
  }
  if (/\btonight\b/i.test(messageLower)) {
    return { type: 'tonight', label: 'tonight', dates: [isoDate(today)] };
  }
  if (/\btoday\b/i.test(messageLower)) {
    return { type: 'today', label: 'today', dates: [isoDate(today)] };
  }

  const weekendPhrase =
    /\b(weekend|this\s+weekend|coming\s+weekend|upcoming\s+weekend)\b/i.test(messageLower);
  if (weekendPhrase) {
    const thisSat = nextSaturdayFrom(today);
    const off = Math.round((thisSat - today) / (24 * 60 * 60 * 1000));
    const dates = weekendSatSunFromOffset(today, off);
    return { type: 'weekend', label: 'this weekend', dates };
  }

  if (/\bnext\s+weekend\b/i.test(messageLower)) {
    const thisSat = nextSaturdayFrom(today);
    const offToThisSat = Math.round((thisSat - today) / (24 * 60 * 60 * 1000));
    const nextSatOff = offToThisSat + 7;
    const dates = weekendSatSunFromOffset(today, nextSatOff);
    return { type: 'next_weekend', label: 'next weekend', dates };
  }

  if (/\bnext week\b/i.test(messageLower)) {
    const start = addDays(today, 7);
    const dates = [];
    for (let i = 0; i < 7; i += 1) dates.push(isoDate(addDays(start, i)));
    return { type: 'next_week', label: 'next week', dates };
  }
  return { type: 'any', label: 'any time', dates: [] };
}

function parseMoodKeywords(messageLower) {
  const known = [
    'chill',
    'romantic',
    'energetic',
    'hype',
    'party',
    'music',
    'concert',
    'comedy',
    'family',
    'kids',
    'workshop',
    'art',
    'outdoor',
    'food',
    'networking',
  ];
  return known.filter((m) => messageLower.includes(m));
}

/** Selangor / KL — rough text match on venue + city + summary */
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

function parseUserIntent(message, baseDate = new Date()) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  const hasDateOrPlace =
    parseDayReference(lower, baseDate).type !== 'any' ||
    parsePlaceFilter(lower).mode !== 'any';

  const vibeAsk =
    /\b(suggest|ideas?|something fun|fun things|what to do|celebrate|graduation|birthday|hangout|outing|plan for)\b/i.test(lower);

  const eventDiscovery =
    /\b(events?|shows?|concerts?|gigs?|festivals?|recommend|things to do|what'?s on|happening|plans?|weekend|tonight|tomorrow)\b/i.test(lower) ||
    vibeAsk ||
    hasDateOrPlace;

  const bookingHelp =
    /\b(how (do|to)|what is|explain|help|booking|book|tickets?|refund|payment|checkout|cancel|account|password|this app|the site|website)\b/i.test(lower);

  const isGeneralQuestion = bookingHelp && !eventDiscovery;
  const isEventRequest = !isGeneralQuestion && (eventDiscovery || hasDateOrPlace);

  const day = parseDayReference(lower, baseDate);
  const mood = parseMoodKeywords(lower);
  const budget = parseBudget(lower);
  const place = parsePlaceFilter(lower);
  const audience = inferAudience(lower);

  return {
    isEventRequest,
    isGeneralQuestion,
    budget,
    mood,
    day,
    place,
    audience,
    query: text,
  };
}

function eventDateISO(event) {
  const raw = String(event?.date || '').trim();
  if (!raw) return null;

  // Keep source date stable (avoid timezone shift from toISOString()).
  const direct = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parsePriceNumber(event) {
  if (event.isFree) return 0;
  const txt = `${event.price || ''}`;
  const m = txt.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
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
  const kidHeavy =
    /\b(kids?|children|toddler|baby|toddler|cocomelon|playground|kindy|nursery|school trip|family fun day)\b/i.test(hay);
  const adultLean =
    /\b(concert|comedy|nightclub|club|bar|mixer|networking|festival|dj|live band|stand[- ]?up|party|gala|dinner)\b/i.test(hay);

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
    if (hay.includes(m)) hits += 1;
  }
  return (hits / mood.length) * 40;
}

function rankEvents(events, intent) {
  return events
    .map((event) => {
      const hay = eventHaystack(event);
      let score = 50 + moodScore(hay, intent.mood || []);
      score += audienceScoreAdjust(hay, intent.audience || {});
      if (/\b(free)\b/i.test(hay) && intent.budget?.type === 'free') score += 15;
      return { event, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.event);
}

/** For weekend, mix Saturday and Sunday in the top picks instead of all from one day. */
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
    i += 1;
  }
  return out;
}

function filterEventsByPreferences(events, preferences) {
  const mood = Array.isArray(preferences?.mood) ? preferences.mood : [];
  const dayDates = new Set(preferences?.day?.dates || []);
  const hasDateFilter = dayDates.size > 0;
  const budget = preferences?.budget || { type: 'any', maxPrice: null };
  const place = preferences?.place || { mode: 'any', keywords: [] };
  const hasPlaceFilter = place.mode !== 'any';

  let out = events.filter((event) => {
    if (hasDateFilter) {
      const ed = eventDateISO(event);
      if (!ed || !dayDates.has(ed)) return false;
    }

    if (budget.type === 'free' && !event.isFree) return false;
    const eventPrice = parsePriceNumber(event);
    if (Number.isFinite(budget.maxPrice) && Number.isFinite(eventPrice) && eventPrice > budget.maxPrice) {
      return false;
    }

    if (mood.length) {
      const hay = `${event.title || ''} ${event.category || ''} ${event.summary || ''}`.toLowerCase();
      const moodHit = mood.some((m) => hay.includes(m));
      if (!moodHit) return false;
    }

    if (hasPlaceFilter) {
      const hay = eventHaystack(event);
      if (!matchesPlace(hay, place)) return false;
    }

    return true;
  });

  const ranked = rankEvents(out, preferences);
  const limit = 15;
  if (preferences?.day?.type === 'weekend' || preferences?.day?.type === 'next_weekend') {
    return pickWeekendBalanced(ranked, preferences, limit);
  }
  return ranked.slice(0, limit);
}

/** Combine recent user lines so follow-ups like "what about Sunday?" still parse. */
function buildIntentContext(message, history) {
  if (!Array.isArray(history) || !history.length) return message;
  const userLines = history
    .filter((h) => h && h.role === 'user' && typeof h.content === 'string')
    .map((h) => h.content.trim())
    .slice(-4);
  const combined = [...userLines, message].filter(Boolean).join(' \n ');
  return combined.slice(-4000);
}

module.exports = {
  calculateNextDate,
  parseUserIntent,
  filterEventsByPreferences,
  buildIntentContext,
};
