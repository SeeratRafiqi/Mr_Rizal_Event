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
    const ok = flightOk && hotelOk;
    btn.disabled = !ok;
    if (!ok) {
      if (!flightOk) {
        btn.title = 'Pick a flight on the Flights tab first.';
      } else if (!hotelOk) {
        btn.title = 'Pick a hotel on the Hotels tab (Add to my itinerary).';
      }
    } else {
      btn.removeAttribute('title');
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
    if (hq) hq.value = suggestHotelQuery(ev);
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
    setTab('itin');

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
    if (
      !hubState.selectedFlight ||
      !hubState.selectedFlight.departure ||
      !hubState.selectedFlight.arrival
    ) {
      if (hint) hint.textContent = 'Choose a flight on the Flights tab and tap Add to my itinerary.';
      setTab('flights');
      return;
    }
    if (
      !hubState.selectedHotel ||
      typeof hubState.selectedHotel !== 'object' ||
      !String(hubState.selectedHotel.name || '').trim()
    ) {
      if (hint)
        hint.textContent =
          'Under Pick your stay, run a hotel search and tap Add to my itinerary beside your preferred property.';
      setTab('hotels');
      return;
    }
    if (hint) hint.textContent = '';
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
      setTab('itin');
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
