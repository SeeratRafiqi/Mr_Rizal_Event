/**
 * Event hub — click an event card to open details with Itinerary / Flights / Hotels tabs.
 * Depends on window.__lastRenderedEventSlice (set in viewer.html when cards render).
 */
(function () {
  'use strict';

  const CITY_HINT_TO_IATA = [
    [/kuala\s*lumpur|kl\b/i, 'KUL'],
    [/penang|george\s*town|pulau\s*pinang/i, 'PEN'],
    [/johor|jb\b|johor\s*bahru/i, 'JHB'],
    [/kota\s*kinabalu|sabah/i, 'BKI'],
    [/kuching|sarawak/i, 'KCH'],
    [/langkawi/i, 'LGK'],
    [/melaka|malacca/i, 'MKZ'],
    [/ipoh/i, 'IPH'],
    [/kota\s*bharu|kelantan/i, 'KBR'],
    [/terengganu|kuala\s*terengganu/i, 'TGG'],
    [/miri/i, 'MYY'],
    [/singapore/i, 'SIN'],
  ];

  function guessDestIata(city, venue) {
    const blob = `${city || ''} ${venue || ''}`;
    for (let i = 0; i < CITY_HINT_TO_IATA.length; i++) {
      if (CITY_HINT_TO_IATA[i][0].test(blob)) return CITY_HINT_TO_IATA[i][1];
    }
    return 'KUL';
  }

  function toIsoDate(d) {
    if (!d) return '';
    const s = String(d).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    return x.toISOString().slice(0, 10);
  }

  function addDaysIso(iso, delta) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').slice(0, 10));
    if (!m) return '';
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Plain-text snippet from listing fields (summary / description / etc.). */
  function pickEventDescriptionSnippet(ev) {
    if (!ev) return '';
    const raw =
      ev.summary ||
      ev.description ||
      ev.details ||
      ev.body ||
      ev.teaser ||
      ev.subtitle ||
      '';
    let s = String(raw)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return '';
    const max = 400;
    return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function scrollMotionBehavior() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return 'auto';
      }
    } catch (e) {
      /* ignore */
    }
    return 'smooth';
  }

  function scrollEventHubToTop() {
    const sc = $('event-hub-scroll') || document.querySelector('.event-hub-scroll');
    if (sc && typeof sc.scrollTo === 'function') {
      sc.scrollTo({ top: 0, behavior: scrollMotionBehavior() });
    }
  }

  function updateEventHubScrollHint() {
    const sc = $('event-hub-scroll');
    const hint = $('event-hub-scroll-hint');
    if (!sc || !hint) return;
    const canScroll = sc.scrollHeight > sc.clientHeight + 8;
    const nearBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 28;
    hint.classList.toggle('is-dismissed', !canScroll || nearBottom || sc.scrollTop > 20);
  }

  let hubState = {
    event: null,
    daysBefore: 1,
    daysAfter: 1,
    arrivalIso: '',
    departureIso: '',
    originIata: 'KUL',
    destIata: 'KUL',
    selectedFlight: null,
    lastFlightRows: [],
    selectedHotel: null,
    lastHotelRows: [],
  };

  function getProfile() {
    if (typeof window.__getEventraProfile === 'function') return window.__getEventraProfile() || {};
    const u = window.__authUser;
    return u && u.profile && typeof u.profile === 'object' ? u.profile : {};
  }

  function budgetLabel(profile) {
    const lvl = Number(profile && profile.budgetLevel);
    if (lvl <= 1) return 'budget';
    if (lvl === 3) return 'comfort';
    if (lvl >= 4) return 'luxury';
    return 'balanced';
  }

  function paceLabel(profile) {
    const pace = String(profile && profile.pacePreference || '').trim();
    if (pace === 'slow') return 'relaxed';
    if (pace === 'packed') return 'full';
    return 'balanced';
  }

  function formatEventDate(ev) {
    const iso = toIsoDate(ev && ev.date);
    if (!iso) return 'the event date';
    try {
      return new Date(iso + 'T12:00:00Z').toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    } catch (e) {
      return iso;
    }
  }

  function tripDayCount() {
    return Number(hubState.daysBefore || 0) + Number(hubState.daysAfter || 0) + 1;
  }

  function profileContextLine(profile) {
    const bits = [];
    const home = String((profile && profile.homeIata) || hubState.originIata || '').toUpperCase();
    if (/^[A-Z]{3}$/.test(home)) bits.push('origin ' + home);
    bits.push(budgetLabel(profile) + ' budget');
    bits.push(paceLabel(profile) + ' pace');
    if (profile && profile.hotelPreference) bits.push('hotel: ' + String(profile.hotelPreference));
    if (profile && profile.travelerType) bits.push(String(profile.travelerType));
    if (profile && profile.language) bits.push(String(profile.language).trim());
    return 'Using profile: ' + bits.filter(Boolean).join(' · ');
  }

  function cityName(ev) {
    return String((ev && ev.city) || '').trim() || 'Malaysia';
  }

  function setTripShape(daysBefore, daysAfter) {
    hubState.daysBefore = Math.max(0, Math.min(14, Number(daysBefore) || 0));
    hubState.daysAfter = Math.max(0, Math.min(14, Number(daysAfter) || 0));
    const dbEl = $('eh-days-before');
    const daEl = $('eh-days-after');
    if (dbEl) dbEl.value = String(hubState.daysBefore);
    if (daEl) daEl.value = String(hubState.daysAfter);
    updateHubSummary();
    updateRouteLine();
    updateHotelRouteBar();
    syncFlightTabInputsFromHub();
  }

  function hotelQueryForChoice(choice) {
    const ev = hubState.event || {};
    const city = cityName(ev);
    const venue = String(ev.venue || '').trim();
    if (choice === 'nightlife') return 'Bukit Bintang, ' + city;
    if (choice === 'transit') return /kuala lumpur|kl/i.test(city + ' ' + venue) ? 'KL Sentral, Kuala Lumpur' : city;
    if (choice === 'luxury') return 'luxury hotels near ' + (venue || city);
    if (choice === 'budget') return 'budget hotels near ' + (venue || city);
    return venue && city ? venue + ', ' + city : city;
  }

  function setHotelChoice(choice) {
    const hq = $('eh-hotel-q');
    if (hq) hq.value = hotelQueryForChoice(choice);
  }

  function renderCopilot(step) {
    const ev = hubState.event || {};
    const profile = getProfile();
    const title = $('eh-copilot-title');
    const copy = $('eh-copilot-copy');
    const grid = $('eh-choice-grid');
    const ctx = $('eh-copilot-context');
    if (!title || !copy || !grid) return;

    const eventDate = formatEventDate(ev);
    const city = cityName(ev);
    const days = tripDayCount();
    const arrival = hubState.arrivalIso || addDaysIso(toIsoDate(ev.date), -1);
    const depart = hubState.departureIso || addDaysIso(toIsoDate(ev.date), 1);
    const from = String((profile.homeIata || hubState.originIata || 'KUL')).toUpperCase();
    const to = String(hubState.destIata || guessDestIata(ev.city, ev.venue) || 'KUL').toUpperCase();
    const choices = [];
    function add(label, action, primary) {
      choices.push(
        '<button type="button" class="eh-choice' +
          (primary ? ' eh-choice--primary' : '') +
          '" data-eh-choice="' +
          escapeHtml(action) +
          '">' +
          escapeHtml(label) +
          '</button>',
      );
    }

    if (step === 'ticket') {
      title.textContent = 'Ticket handoff is external';
      copy.textContent =
        'Tickets are available through the event provider. Eventra will keep the provider link with this trip plan, but booking happens outside Eventra.';
      add('Open ticket provider', 'ticket-open', true);
      add('Continue planning', 'step-flight');
    } else if (step === 'flight') {
      title.textContent = 'Recommended flight timing';
      if (!to || from === to) {
        copy.textContent =
          'Your profile origin appears to match this Malaysia destination. I can skip flights for now and plan the city experience around the event. Update your profile later if you are flying in internationally.';
        add('I am already in Malaysia', 'flight-local', true);
        add('Update profile origin', 'profile-open');
        add('Continue to stay areas', 'step-hotel');
      } else {
        copy.textContent =
          'Based on your profile, I will search from ' +
          from +
          ' to ' +
          to +
          '. For this event on ' +
          eventDate +
          ', arrive before 2PM on ' +
          arrival +
          ' so you have time for check-in, traffic and a calm first evening.';
        add('Find recommended flights', 'flight-recommended', true);
        add('Cheapest flights', 'flight-cheapest');
        add('Most comfortable flights', 'flight-comfort');
        add('I am already in Malaysia', 'flight-local');
      }
    } else if (step === 'hotel') {
      title.textContent = 'Best stay area';
      copy.textContent =
        'For ' +
        city +
        ', I suggest starting from your profile preference (' +
        String(profile.hotelPreference || 'near venue') +
        '), then choosing nightlife, transit, luxury or budget if this trip needs a different base.';
      add('Stay near venue', 'hotel-venue', true);
      add('Stay near nightlife', 'hotel-nightlife');
      add('Stay near airport/train', 'hotel-transit');
      add('Luxury hotels', 'hotel-luxury');
      add('Budget hotels', 'hotel-budget');
    } else if (step === 'itinerary') {
      title.textContent = 'Build the AI itinerary';
      copy.textContent =
        'I can now build your trip using the selected event, ' +
        days +
        '-day trip window, travel profile, flight timing and stay preference.';
      add('Generate itinerary', 'itin-generate', true);
      add('Generate budget plan', 'itin-budget');
      add('Generate luxury plan', 'itin-luxury');
      add('Generate food-focused plan', 'itin-food');
    } else {
      title.textContent = 'Recommended ' + days + '-day trip';
      copy.textContent =
        'This event is on ' +
        eventDate +
        ' in ' +
        city +
        '. Based on your profile, I suggest arriving on ' +
        arrival +
        ', attending the event, and leaving on ' +
        depart +
        '.';
      add('Use ' + days + '-day plan', 'step-ticket', true);
      add('Make it shorter', 'trip-short');
      add('Make it longer', 'trip-long');
      add('Show luxury version', 'trip-luxury');
    }
    grid.innerHTML = choices.join('');
    if (ctx) ctx.textContent = profileContextLine(profile);
  }

  function syncTripDatesFromInputs() {
    const db = Math.min(14, Math.max(0, parseInt($('eh-days-before')?.value || '1', 10) || 0));
    const da = Math.min(14, Math.max(0, parseInt($('eh-days-after')?.value || '1', 10) || 0));
    const evIso = toIsoDate(hubState.event && hubState.event.date);
    if (!evIso) {
      hubState.arrivalIso = '';
      hubState.departureIso = '';
      return;
    }
    hubState.daysBefore = db;
    hubState.daysAfter = da;
    hubState.arrivalIso = addDaysIso(evIso, -db);
    hubState.departureIso = addDaysIso(evIso, da);
    if (hubState.departureIso < hubState.arrivalIso) {
      hubState.departureIso = hubState.arrivalIso;
    }
    const maxLen = 14;
    let len =
      Math.round(
        (new Date(hubState.departureIso + 'T12:00:00Z') - new Date(hubState.arrivalIso + 'T12:00:00Z')) /
          86400000,
      ) + 1;
    if (len > maxLen) {
      hubState.departureIso = addDaysIso(hubState.arrivalIso, maxLen - 1);
    }
  }

  function updateHubSummary() {
    syncTripDatesFromInputs();
    updateTripStory();
    const el = $('eh-trip-summary');
    if (!el) return;
    if (!hubState.arrivalIso || !hubState.departureIso) {
      el.textContent = 'Set the event date or adjust days around the event.';
      return;
    }
    el.textContent =
      'Trip window: ' +
      hubState.arrivalIso +
      ' → ' +
      hubState.departureIso +
      ' · Event: ' +
      toIsoDate(hubState.event && hubState.event.date);
  }

  function updateRouteLine() {
    syncTripDatesFromInputs();
    const route = $('eh-route-line');
    const dates = $('eh-route-dates');
    if (route) {
      if (hubState.arrivalIso) {
        route.textContent = 'Outbound flight date: ' + hubState.arrivalIso;
      } else {
        route.textContent = 'Set trip dates in the strip above (days before/after the event).';
      }
    }
    if (dates) {
      dates.textContent =
        hubState.arrivalIso && hubState.departureIso
          ? 'Arrive ' + hubState.arrivalIso + ' · Depart ' + hubState.departureIso
          : '—';
    }
  }

  function syncFlightTabInputsFromHub() {
    const ff = $('eh-flight-from');
    const ft = $('eh-flight-to');
    if (ff) ff.value = hubState.originIata || '';
    if (ft) ft.value = hubState.destIata || '';
  }

  function readFlightTabIata() {
    const from = String($('eh-flight-from')?.value || hubState.originIata || 'KUL')
      .trim()
      .toUpperCase()
      .slice(0, 3);
    const to = String($('eh-flight-to')?.value || hubState.destIata || '')
      .trim()
      .toUpperCase()
      .slice(0, 3);
    return { from, to };
  }

  function suggestHotelQuery(ev) {
    if (!ev) return 'Malaysia';
    const city = String(ev.city || '').trim();
    const venue = String(ev.venue || '').trim();
    if (venue && city) return venue + ', ' + city;
    return city || venue || 'Malaysia';
  }

  function eventBlob(ev) {
    return [ev?.title, ev?.category, ev?.summary, ev?.venue, ev?.city].filter(Boolean).join(' ').toLowerCase();
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text || '';
  }

  function inferTripStory(ev) {
    const blob = eventBlob(ev);
    const city = String(ev?.city || '').trim() || 'Malaysia';
    let why = 'A live Malaysia moment';
    let whyCopy = 'Pair the event with food, culture and city time.';
    if (/(concert|tour|fancon|music|dj|nightlife)/.test(blob)) {
      why = 'A sound-led city escape';
      whyCopy = 'Build the trip around the show, then add late-night food and a relaxed next morning.';
    } else if (/(culture|arts|festival|heritage|creative|exhibition)/.test(blob)) {
      why = 'A culture-rich weekend';
      whyCopy = 'Use the event as an anchor for museums, street food, local markets and neighbourhood walks.';
    } else if (/(sports|championship|marathon|fitness|race)/.test(blob)) {
      why = 'A high-energy travel anchor';
      whyCopy = 'Balance event energy with recovery meals, easy transfers and nearby attractions.';
    } else if (/(food|drink|dining|cafe)/.test(blob)) {
      why = 'A taste-first itinerary';
      whyCopy = 'Let Malaysia sell itself through local flavours before and after the event.';
    }
    const base = city && city !== 'Malaysia' ? city : 'Near the venue';
    const baseCopy = /kuala lumpur|bukit bintang|kl|axiata|zepp/i.test([ev?.city, ev?.venue].join(' '))
      ? 'Stay near Bukit Bintang, KL Sentral or the venue corridor for smoother late-night movement.'
      : 'Stay close to the venue first; branch out for food and culture once the event timing is clear.';
    const days = Number(hubState.daysBefore || 0) + Number(hubState.daysAfter || 0) + 1;
    return {
      why,
      whyCopy,
      base,
      baseCopy,
      duration: days + ' day' + (days === 1 ? '' : 's'),
      durationCopy: days <= 2
        ? 'Compact event escape with one or two local highlights.'
        : 'Enough room for the event, recovery time and a proper city layer.',
    };
  }

  function updateTripStory() {
    const story = inferTripStory(hubState.event || {});
    setText('eh-ai-why', story.why);
    setText('eh-ai-why-copy', story.whyCopy);
    setText('eh-ai-base', story.base);
    setText('eh-ai-base-copy', story.baseCopy);
    setText('eh-ai-duration', story.duration);
    setText('eh-ai-duration-copy', story.durationCopy);
  }

  function updateHotelRouteBar() {
    syncTripDatesFromInputs();
    const line = $('eh-hotel-route-line');
    const dates = $('eh-hotel-route-dates');
    if (line) {
      if (hubState.arrivalIso) {
        line.textContent = 'Check-in: ' + hubState.arrivalIso;
      } else {
        line.textContent = 'Set trip dates in the strip above';
      }
    }
    if (dates) {
      dates.textContent =
        hubState.arrivalIso && hubState.departureIso
          ? 'Check-in ' + hubState.arrivalIso + ' · Check-out ' + hubState.departureIso
          : '—';
    }
  }

  function setTab(which) {
    ['flights', 'hotels', 'itin'].forEach(function (w) {
      const btn = $('eh-tab-' + w);
      const panel = $('eh-panel-' + w);
      const on = w === which;
      if (btn) {
        btn.classList.toggle('eh-tab--active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      if (panel) {
        panel.hidden = !on;
        if (on) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
      }
    });
    updateGenButtonStateHub();
    scrollEventHubToTop();
    requestAnimationFrame(updateEventHubScrollHint);
  }

  function updateHubFlightSummaryUI() {
    const box = $('eh-hub-flight-summary');
    const sf = hubState.selectedFlight;
    if (!box) return;
    if (!sf || typeof sf !== 'object') {
      box.hidden = true;
      box.setAttribute('hidden', '');
      box.innerHTML = '';
      return;
    }
    const dep = (sf.departure && (sf.departure.name || sf.departure.id)) || '—';
    const arr = (sf.arrival && (sf.arrival.name || sf.arrival.id)) || '—';
    const t = (sf.departure && sf.departure.time) || '—';
    const p =
      Number(sf.price) === Number(sf.price)
        ? 'RM ' + Number(sf.price).toLocaleString('en-MY', { maximumFractionDigits: 0 })
        : '—';
    box.innerHTML =
      '<strong>Your flight</strong> · ' +
      escapeHtml(String(sf.airline || '').trim()) +
      ' ' +
      escapeHtml(String(sf.flightNumber || '').trim()) +
      '<br />' +
      escapeHtml(dep) +
      ' → ' +
      escapeHtml(arr) +
      '<br />Departs ' +
      escapeHtml(String(t).slice(0, 24)) +
      ' · Price ' +
      escapeHtml(p);
    box.hidden = false;
    box.removeAttribute('hidden');
  }

  function updateHubHotelSummaryUI() {
    const box = $('eh-hub-hotel-summary');
    const h = hubState.selectedHotel;
    if (!box) return;
    if (!h || typeof h !== 'object' || !String(h.name || '').trim()) {
      box.hidden = true;
      box.setAttribute('hidden', '');
      box.innerHTML = '';
      return;
    }
    const rt =
      h.overallRating != null && Number.isFinite(Number(h.overallRating))
        ? Number(h.overallRating).toFixed(1)
        : '—';
    const rev = h.reviewsCount != null && Number.isFinite(Number(h.reviewsCount)) ? String(h.reviewsCount) : '';
    const price = escapeHtml(String(h.priceLabel || '—').trim());
    const ci = escapeHtml(String(h.checkIn || '').slice(0, 10));
    const co = escapeHtml(String(h.checkOut || '').slice(0, 10));
    box.innerHTML =
      '<strong>Your stay</strong> · ' +
      escapeHtml(String(h.name || '').trim()) +
      (h.type ? ' · ' + escapeHtml(String(h.type).trim()) : '') +
      '<br />Rating ' +
      escapeHtml(rt) +
      (rev ? ' · ' + escapeHtml(rev) + ' reviews' : '') +
      ' · ' +
      price +
      '<br />Check-in ' +
      ci +
      ' · Check-out ' +
      co;
    box.hidden = false;
    box.removeAttribute('hidden');
  }

  function updateGenButtonStateHub() {
    const btn = $('eh-gen-itin');
    if (!btn) return;
    const flightOk =
      hubState.selectedFlight &&
      typeof hubState.selectedFlight === 'object' &&
      hubState.selectedFlight.departure &&
      hubState.selectedFlight.arrival;
    const hotelOk =
      hubState.selectedHotel &&
      typeof hubState.selectedHotel === 'object' &&
      String(hubState.selectedHotel.name || '').trim().length >= 2;
    btn.disabled = !hubState.event || !hubState.arrivalIso || !hubState.departureIso;
    if (btn.disabled) {
      btn.title = 'Set a valid event trip window first.';
      btn.textContent = 'Draft AI trip first';
    } else {
      btn.removeAttribute('title');
      btn.textContent = flightOk || hotelOk ? 'Refine AI trip with selections' : 'Draft AI trip first';
    }
  }

  function closeHub() {
    const m = $('event-hub-modal');
    if (!m) return;
    m.classList.remove('is-open');
    m.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('event-hub-open');
  }

  function openHub(ev) {
    if (!ev) return;
    hubState.event = ev;
    hubState.daysBefore = 1;
    hubState.daysAfter = 1;
    hubState.originIata =
      typeof window.__getHomeIataFromProfile === 'function' ? window.__getHomeIataFromProfile() : 'KUL';
    hubState.destIata = guessDestIata(ev.city, ev.venue);
    if (!hubState.destIata || hubState.destIata === hubState.originIata) {
      hubState.destIata = '';
    }

    const m = $('event-hub-modal');
    const img = $('eh-hero-img');
    const ph = $('eh-hero-placeholder');
    const title = $('eh-hero-title');
    const meta = $('eh-hero-meta');
    const book = $('eh-book-btn');
    if (!m) return;

    if (title) title.textContent = ev.title || 'Event';
    if (meta) {
      meta.textContent = [ev.venue, ev.city, ev.date ? new Date(ev.date).toDateString() : 'Date TBA']
        .filter(Boolean)
        .join(' · ');
    }
    if (book) {
      if (ev.url) {
        book.href = ev.url;
        book.hidden = false;
        book.removeAttribute('hidden');
      } else {
        book.hidden = true;
        book.setAttribute('hidden', '');
        book.removeAttribute('href');
      }
    }
    if (img && ph) {
      if (ev.image) {
        img.src = ev.image;
        img.alt = ev.title || '';
        img.hidden = false;
        img.removeAttribute('hidden');
        ph.hidden = true;
        ph.setAttribute('hidden', '');
      } else {
        img.removeAttribute('src');
        img.hidden = true;
        img.setAttribute('hidden', '');
        ph.hidden = false;
        ph.removeAttribute('hidden');
      }
    }

    const descEl = $('eh-event-desc');
    if (descEl) {
      const snippet = pickEventDescriptionSnippet(ev);
      if (snippet) {
        descEl.textContent = snippet;
        descEl.hidden = false;
        descEl.removeAttribute('hidden');
      } else {
        descEl.textContent = '';
        descEl.hidden = true;
        descEl.setAttribute('hidden', '');
      }
    }

    const dbEl = $('eh-days-before');
    const daEl = $('eh-days-after');
    if (dbEl) dbEl.value = String(hubState.daysBefore);
    if (daEl) daEl.value = String(hubState.daysAfter);

    updateHubSummary();
    updateRouteLine();
    syncFlightTabInputsFromHub();
    const hq = $('eh-hotel-q');
    if (hq) hq.value = hotelQueryForChoice(getProfile().hotelPreference || 'venue') || suggestHotelQuery(ev);
    const hotelsRes = $('eh-hotels-results');
    if (hotelsRes) hotelsRes.innerHTML = '';
    updateHotelRouteBar();
    const fr = $('eh-flights-results');
    if (fr) fr.innerHTML = '';
    hubState.selectedFlight = null;
    hubState.lastFlightRows = [];
    hubState.selectedHotel = null;
    hubState.lastHotelRows = [];
    updateHubFlightSummaryUI();
    updateHubHotelSummaryUI();
    updateGenButtonStateHub();
    updateTripStory();
    setTab('itin');
    renderCopilot('trip');

    m.classList.add('is-open');
    m.setAttribute('aria-hidden', 'false');
    document.body.classList.add('event-hub-open');
    requestAnimationFrame(updateEventHubScrollHint);
  }

  async function generateItineraryFromHub() {
    syncTripDatesFromInputs();
    const ev = hubState.event;
    if (!ev || !hubState.arrivalIso || !hubState.departureIso) return;
    const hint = $('eh-gen-hint');
    if (hint) {
      hint.textContent =
        hubState.selectedFlight || hubState.selectedHotel
          ? 'Using your selected travel context to refine the draft.'
          : 'Creating a first AI travel draft. You can add flights and hotels after.';
    }
    const plannerEv = {
      id: ev.id != null ? ev.id : '',
      title: ev.title || 'Event',
      date: ev.date || '',
      city: String(ev.city || '').trim(),
      url: String(ev.url || '').trim(),
      venue: String(ev.venue || '').trim(),
    };
    if (typeof window.__hubItineraryGenerate !== 'function') return;
    closeHub();
    await window.__hubItineraryGenerate({
      event: plannerEv,
      arrivalDate: hubState.arrivalIso,
      departureDate: hubState.departureIso,
      selectedFlight: hubState.selectedFlight,
      selectedHotel: hubState.selectedHotel,
    });
  }

  function openHotels() {
    syncTripDatesFromInputs();
    const ev = hubState.event;
    if (!ev) return;
    if (typeof window.__prefillHotelModal === 'function') {
      window.__prefillHotelModal({
        venue: ev.venue || '',
        city: ev.city || '',
        depart: hubState.arrivalIso,
        ret: hubState.departureIso,
      });
    }
  }

  async function searchGoogleFlights() {
    const host = $('eh-flights-results');
    const H = window.__serpFlightsHelpers;
    if (!host) return;
    if (!H) {
      host.innerHTML =
        '<p class="eh-muted">Flight search script failed to load. Refresh the page and try again.</p>';
      return;
    }
    syncTripDatesFromInputs();
    const { from, to } = readFlightTabIata();
    const date = hubState.arrivalIso;
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || from === to) {
      hubState.lastFlightRows = [];
      host.innerHTML =
        '<p class="eh-muted">Enter two different 3-letter airport codes in From and To.</p>';
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      hubState.lastFlightRows = [];
      host.innerHTML = '<p class="eh-muted">Set trip dates in the strip above (days before/after the event).</p>';
      return;
    }
    hubState.originIata = from;
    hubState.destIata = to;
    hubState.selectedFlight = null;
    hubState.lastFlightRows = [];
    hubState.selectedHotel = null;
    updateHubFlightSummaryUI();
    updateHubHotelSummaryUI();
    updateGenButtonStateHub();
    host.innerHTML = '<p class="eh-loading">Searching Google Flights…</p>';
    try {
      const data = await H.fetchSerpFlights(
        { from: from, to: to, date: date, passengers: 1, type: '2' },
        undefined,
      );
      const rows = H.mergeSerpLists(data);
      const book = H.bookUrlFromResponse(data);
      if (!rows.length) {
        hubState.lastFlightRows = [];
        host.innerHTML =
          '<p class="eh-muted">No flights returned for this route and date. Try other dates or airports.</p>';
        return;
      }
      hubState.lastFlightRows = rows;
      host.innerHTML =
        '<ul class="eh-flight-list">' +
        H.renderSerpFlightListItems(rows, book, true) +
        '</ul>' +
        '<p class="eh-footnote">Results from Google Flights (SerpAPI). Confirm times and prices before booking.</p>';
    } catch (e) {
      hubState.lastFlightRows = [];
      host.innerHTML = '<p class="eh-muted">' + escapeHtml(e.message || 'Flight search failed') + '</p>';
    }
  }

  async function searchGoogleHotelsSerp() {
    const host = $('eh-hotels-results');
    const H = window.__serpHotelsHelpers;
    if (!host) return;
    if (!H) {
      host.innerHTML =
        '<p class="eh-muted">Hotel search script failed to load. Refresh the page and try again.</p>';
      return;
    }
    syncTripDatesFromInputs();
    let checkIn = hubState.arrivalIso;
    let checkOut = hubState.departureIso;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) {
      hubState.lastHotelRows = [];
      host.innerHTML = '<p class="eh-muted">Set trip dates in the strip above (days before/after the event).</p>';
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || checkOut <= checkIn) {
      checkOut = addDaysIso(checkIn, 1);
    }
    const q = String($('eh-hotel-q')?.value || '').trim();
    if (q.length < 2) {
      hubState.lastHotelRows = [];
      host.innerHTML = '<p class="eh-muted">Enter a destination (at least 2 characters).</p>';
      return;
    }
    hubState.selectedHotel = null;
    hubState.lastHotelRows = [];
    updateHubHotelSummaryUI();
    updateGenButtonStateHub();
    host.innerHTML = '<p class="eh-loading">Searching Google Hotels…</p>';
    try {
      const data = await H.fetchSerpHotels(
        { q: q, checkIn: checkIn, checkOut: checkOut, adults: 2 },
        undefined,
      );
      const rows = H.mergeHotelProperties(data);
      const book = H.hotelsBookUrlFromResponse(data);
      if (!rows.length) {
        hubState.lastHotelRows = [];
        host.innerHTML =
          '<p class="eh-muted">No hotels returned for this search. Try another destination or dates.</p>';
        return;
      }
      hubState.lastHotelRows = rows;
      host.innerHTML =
        '<ul class="eh-flight-list">' +
        H.renderSerpHotelListItems(rows, book, true) +
        '</ul>' +
        '<p class="eh-footnote">Results from Google Hotels (SerpAPI). Confirm prices and policies before booking.</p>';
    } catch (e) {
      hubState.lastHotelRows = [];
      host.innerHTML = '<p class="eh-muted">' + escapeHtml(e.message || 'Hotel search failed') + '</p>';
    }
  }

  function openTicketProvider() {
    const ev = hubState.event || {};
    const url = String(ev.url || '').trim();
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function markFlightLocal() {
    hubState.selectedFlight = null;
    updateHubFlightSummaryUI();
    const host = $('eh-flights-results');
    if (host) {
      host.innerHTML =
        '<p class="eh-muted">Noted. Eventra will plan this as an in-Malaysia trip and keep airport timing optional.</p>';
    }
    setTab('hotels');
    renderCopilot('hotel');
  }

  function prepareItineraryVariant(kind) {
    const hint = $('eh-gen-hint');
    if (!hint) return;
    if (kind === 'budget') {
      hint.textContent = 'Budget version selected: Qwen will favor street food, public transport and best-value stays.';
    } else if (kind === 'luxury') {
      hint.textContent = 'Luxury version selected: Qwen will favor premium hotels, calmer transfers and elevated dining.';
    } else if (kind === 'food') {
      hint.textContent = 'Food-focused version selected: Qwen will emphasize hawker culture, cafes, markets and late-night eats.';
    }
  }

  function onCopilotChoice(action) {
    if (!action) return;
    if (action === 'trip-short') {
      setTripShape(0, 1);
      renderCopilot('trip');
      return;
    }
    if (action === 'trip-long') {
      setTripShape(2, 2);
      renderCopilot('trip');
      return;
    }
    if (action === 'trip-luxury') {
      setTripShape(1, 2);
      setHotelChoice('luxury');
      renderCopilot('ticket');
      return;
    }
    if (action === 'step-ticket') {
      renderCopilot('ticket');
      return;
    }
    if (action === 'ticket-open') {
      openTicketProvider();
      renderCopilot('flight');
      return;
    }
    if (action === 'step-flight') {
      renderCopilot('flight');
      return;
    }
    if (action === 'step-hotel') {
      setTab('hotels');
      renderCopilot('hotel');
      return;
    }
    if (action === 'profile-open') {
      window.location.href = '/profile';
      return;
    }
    if (action === 'flight-local') {
      markFlightLocal();
      return;
    }
    if (/^flight-/.test(action)) {
      setTab('flights');
      const msg = $('eh-gen-hint');
      if (msg) {
        msg.textContent =
          action === 'flight-cheapest'
            ? 'Cheapest flight preference noted. Compare baggage and arrival buffer before opening the provider.'
            : action === 'flight-comfort'
              ? 'Comfort flight preference noted. Favor fewer stops and safer arrival timing.'
              : 'Recommended timing selected. Eventra will prioritize arrival buffer before the event.';
      }
      void searchGoogleFlights();
      return;
    }
    if (/^hotel-/.test(action)) {
      const choice = action.replace('hotel-', '');
      setHotelChoice(choice);
      setTab('hotels');
      renderCopilot('itinerary');
      void searchGoogleHotelsSerp();
      return;
    }
    if (action === 'itin-generate' || action === 'itin-budget' || action === 'itin-luxury' || action === 'itin-food') {
      prepareItineraryVariant(action.replace('itin-', ''));
      void generateItineraryFromHub();
    }
  }

  function onGridClick(e) {
    const card = e.target.closest('#grid .card[data-ev-idx]');
    if (!card) return;
    if (e.target.closest('a.card-link')) return;
    const idx = parseInt(card.getAttribute('data-ev-idx'), 10);
    const list = window.__lastRenderedEventSlice;
    if (!list || Number.isNaN(idx) || !list[idx]) return;
    e.preventDefault();
    openHub(list[idx]);
  }

  function init() {
    document.addEventListener('click', onGridClick);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = document.activeElement && document.activeElement.closest('.card[data-ev-idx]');
      if (!card || !document.getElementById('grid')?.contains(card)) return;
      e.preventDefault();
      card.click();
    });

    $('eh-modal-close')?.addEventListener('click', closeHub);
    $('eh-modal-backdrop')?.addEventListener('click', closeHub);
    const ehScroll = $('event-hub-scroll');
    if (ehScroll) {
      ehScroll.addEventListener('scroll', updateEventHubScrollHint, { passive: true });
    }
    window.addEventListener('resize', updateEventHubScrollHint, { passive: true });

    $('eh-tab-itin')?.addEventListener('click', function () {
      setTab('itin');
    });
    $('eh-tab-flights')?.addEventListener('click', function () {
      setTab('flights');
      syncFlightTabInputsFromHub();
      updateRouteLine();
    });
    $('eh-tab-hotels')?.addEventListener('click', function () {
      setTab('hotels');
      updateHotelRouteBar();
    });

    $('eh-apply-dates')?.addEventListener('click', function () {
      syncTripDatesFromInputs();
      const { from, to } = readFlightTabIata();
      hubState.originIata = /^[A-Z]{3}$/.test(from)
        ? from
        : typeof window.__getHomeIataFromProfile === 'function'
          ? window.__getHomeIataFromProfile()
          : 'KUL';
      hubState.destIata = /^[A-Z]{3}$/.test(to) ? to : '';
      updateHubSummary();
      updateRouteLine();
      updateHotelRouteBar();
      syncFlightTabInputsFromHub();
      setTab('flights');
      renderCopilot('flight');
      void searchGoogleFlights();
    });

    $('eh-gen-itin')?.addEventListener('click', function () {
      void generateItineraryFromHub();
    });
    $('eh-open-hotels')?.addEventListener('click', function () {
      openHotels();
      closeHub();
    });
    $('eh-google-flights-btn')?.addEventListener('click', function () {
      void searchGoogleFlights();
    });
    $('eh-google-hotels-btn')?.addEventListener('click', function () {
      void searchGoogleHotelsSerp();
    });

    $('eh-choice-grid')?.addEventListener('click', function (e) {
      const b = e.target.closest('[data-eh-choice]');
      if (!b) return;
      e.preventDefault();
      onCopilotChoice(b.getAttribute('data-eh-choice'));
    });

    $('eh-flights-results')?.addEventListener('click', function (e) {
      const b = e.target.closest('[data-eh-add-flight]');
      if (!b) return;
      e.preventDefault();
      const idx = parseInt(b.getAttribute('data-eh-add-flight'), 10);
      const row = hubState.lastFlightRows[idx];
      const H = window.__serpFlightsHelpers;
      if (!row || !H || typeof H.serializeForItinerary !== 'function') return;
      hubState.selectedFlight = H.serializeForItinerary(row);
      updateHubFlightSummaryUI();
      updateGenButtonStateHub();
      setTab('hotels');
      renderCopilot('hotel');
    });

    $('eh-hotels-results')?.addEventListener('click', function (e) {
      const b = e.target.closest('[data-eh-add-hotel]');
      if (!b) return;
      e.preventDefault();
      const idx = parseInt(b.getAttribute('data-eh-add-hotel'), 10);
      const row = hubState.lastHotelRows[idx];
      const H = window.__serpHotelsHelpers;
      if (!row || !H || typeof H.serializeForItinerary !== 'function') return;
      syncTripDatesFromInputs();
      let checkOut = hubState.departureIso;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || checkOut <= hubState.arrivalIso) {
        checkOut = addDaysIso(hubState.arrivalIso, 1);
      }
      hubState.selectedHotel = H.serializeForItinerary(row, hubState.arrivalIso, checkOut);
      updateHubHotelSummaryUI();
      updateGenButtonStateHub();
      setTab('itin');
      renderCopilot('itinerary');
    });

    document.addEventListener(
      'keydown',
      function (e) {
        if (e.key !== 'Escape') return;
        const m = $('event-hub-modal');
        if (m && m.classList.contains('is-open')) {
          e.stopPropagation();
          closeHub();
        }
      },
      true,
    );

    document.addEventListener('ts-auth-change', function () {
      const h =
        typeof window.__getHomeIataFromProfile === 'function' ? window.__getHomeIataFromProfile() : 'KUL';
      hubState.originIata = h;
      syncFlightTabInputsFromHub();
    });
  }

  window.__openEventHub = openHub;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
