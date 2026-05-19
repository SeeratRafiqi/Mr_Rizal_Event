/**
 * Shared client helpers for SerpAPI Google Flights (via GET /api/flights).
 * Loaded before event-hub.js and itinerary-modal.js — exposes window.__serpFlightsHelpers.
 */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function mergeSerpLists(data) {
    const best = Array.isArray(data.best_flights) ? data.best_flights : [];
    const other = Array.isArray(data.other_flights) ? data.other_flights : [];
    return best.concat(other);
  }

  function formatDurationMinutes(min) {
    const m = Math.round(Number(min) || 0);
    if (m <= 0) return '—';
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h <= 0) return r + 'm';
    return r ? h + 'h ' + r + 'm' : h + 'h';
  }

  function timeOnly(isoLike) {
    const s = String(isoLike || '').trim();
    const m = /\d{2}:\d{2}/.exec(s);
    return m ? m[0] : '—';
  }

  function layoverSummary(f) {
    const lay = f.layovers;
    if (lay && lay.length) {
      const names = lay
        .map(function (l) {
          return l.id || l.name || '';
        })
        .filter(Boolean);
      return (
        lay.length +
        ' stop' +
        (lay.length === 1 ? '' : 's') +
        (names.length ? ' (' + names.join(', ') + ')' : '')
      );
    }
    const legs = f.flights || [];
    if (legs.length <= 1) return 'Nonstop';
    const n = Math.max(0, legs.length - 1);
    return n + ' stop' + (n === 1 ? '' : 's');
  }

  function aiFlightInsight(f, idx) {
    const price = Number(f && f.price);
    const stops =
      Array.isArray(f?.layovers) && f.layovers.length
        ? f.layovers.length
        : Math.max(0, ((f && f.flights) || []).length - 1);
    const duration = Number(f && f.total_duration) || 0;
    const first = ((f && f.flights) || [])[0] || {};
    const depTime = timeOnly(first.departure_airport && first.departure_airport.time);
    if (idx === 0) {
      return {
        label: 'AI pick: best arrival buffer',
        reason: 'Start here: it is ranked highly by Google Flights and gives the itinerary a safer travel anchor.',
      };
    }
    if (Number.isFinite(price) && price > 0 && price < 350) {
      return {
        label: 'Budget-smart route',
        reason: 'Lower fare signal; confirm baggage, timing and provider terms before leaving Eventra.',
      };
    }
    if (stops === 0 && duration && duration <= 180) {
      return {
        label: 'Fastest city entry',
        reason: 'Nonstop timing keeps the event-day plan simple and reduces transfer uncertainty.',
      };
    }
    if (stops > 0) {
      return {
        label: 'Comfort check needed',
        reason: 'This route has a connection; keep extra buffer before check-in and the event start.',
      };
    }
    if (/^(2[0-3]|00|01):/.test(depTime)) {
      return {
        label: 'Late timing watch',
        reason: 'A late departure can compress hotel check-in or rest time. Use only if the price is compelling.',
      };
    }
    return {
      label: 'Balanced option',
      reason: 'A reasonable fallback if the recommended route does not fit your origin, budget or schedule.',
    };
  }

  function serializeForItinerary(f) {
    const legs = f.flights || [];
    const first = legs[0] || {};
    const last = legs[legs.length - 1] || first;
    const depRaw = first.departure_airport || {};
    const arrRaw = last.arrival_airport || {};
    const stops =
      Array.isArray(f.layovers) && f.layovers.length
        ? f.layovers.length
        : Math.max(0, legs.length - 1);
    return {
      airline: String(first.airline || '').trim(),
      flightNumber: String(first.flight_number || '').trim(),
      departure: {
        id: String(depRaw.id || '').trim(),
        name: String(depRaw.name || depRaw.id || '').trim(),
        time: String(depRaw.time || '').trim(),
      },
      arrival: {
        id: String(arrRaw.id || '').trim(),
        name: String(arrRaw.name || arrRaw.id || '').trim(),
        time: String(arrRaw.time || '').trim(),
      },
      duration: f.total_duration,
      price: f.price,
      stops: stops,
    };
  }

  /**
   * @param {Array<object>} flights
   * @param {string} bookUrl
   * @param {boolean} hubPick — when true, append “Add to my itinerary” per row (event hub).
   * @returns {string} concatenated <li>...</li>
   */
  function renderSerpFlightListItems(flights, bookUrl, hubPick) {
    const href = escapeHtml(bookUrl || 'https://www.google.com/travel/flights');
    return flights
      .map(function (f, idx) {
        const insight = aiFlightInsight(f, idx);
        const legs = f.flights || [];
        const first = legs[0] || {};
        const last = legs[legs.length - 1] || first;
        const logo = escapeHtml(f.airline_logo || first.airline_logo || '');
        const airlines = legs
          .map(function (l) {
            return l.airline;
          })
          .filter(Boolean)
          .filter(function (a, i, arr) {
            return arr.indexOf(a) === i;
          })
          .join(', ') || '—';
        const nums =
          legs
            .map(function (l) {
              return l.flight_number;
            })
            .filter(Boolean)
            .join(' · ') || '—';
        const depName = (first.departure_airport && first.departure_airport.id) || '';
        const arrName = (last.arrival_airport && last.arrival_airport.id) || '';
        const depT = timeOnly(first.departure_airport && first.departure_airport.time);
        const arrT = timeOnly(last.arrival_airport && last.arrival_airport.time);
        const dur = formatDurationMinutes(f.total_duration);
        const stops = layoverSummary(f);
        const priceNum = Number(f.price);
        const priceStr =
          priceNum === priceNum
            ? 'MYR ' + priceNum.toLocaleString('en-MY', { maximumFractionDigits: 0 })
            : '—';
        const logoBlock = logo
          ? '<img class="eh-serp-logo" src="' +
            logo +
            '" alt="" width="36" height="36" loading="lazy" decoding="async" />'
          : '<div class="eh-serp-logo eh-serp-logo--ph" aria-hidden="true"></div>';
        return (
          '<li class="eh-flight-row eh-serp-row">' +
          '<div class="eh-serp-left">' +
          logoBlock +
          '<div class="eh-serp-mid">' +
          '<span class="eh-ai-rec">' +
          escapeHtml(insight.label) +
          '</span>' +
          '<div><strong>' +
          escapeHtml(airlines) +
          '</strong></div>' +
          '<span class="eh-flight-sub">' +
          escapeHtml(nums) +
          '</span>' +
          '<span class="eh-flight-sub"><strong>' +
          escapeHtml(depT) +
          '</strong> → <strong>' +
          escapeHtml(arrT) +
          '</strong> · ' +
          escapeHtml(depName) +
          ' → ' +
          escapeHtml(arrName) +
          '</span>' +
          '<span class="eh-flight-sub">' +
          escapeHtml(dur) +
          ' · ' +
          escapeHtml(stops) +
          '</span>' +
          '<span class="eh-ai-reason">' +
          escapeHtml(insight.reason) +
          '</span>' +
          '</div></div>' +
          '<div class="eh-flight-meta">' +
          '<span class="eh-price">' +
          escapeHtml(priceStr) +
          '</span>' +
          (hubPick
            ? '<button type="button" class="eh-btn eh-btn--gold eh-serp-add-itin" data-eh-add-flight="' +
              idx +
              '">Add to my itinerary</button>'
            : '') +
          '<a class="eh-btn eh-btn--ghost eh-serp-book" href="' +
          href +
          '" target="_blank" rel="noopener noreferrer">Open provider</a>' +
          '</div></li>'
        );
      })
      .join('');
  }

  function bookUrlFromResponse(data) {
    return (
      (data.search_metadata && data.search_metadata.google_flights_url) ||
      'https://www.google.com/travel/flights'
    );
  }

  function fetchSerpFlights(params, signal) {
    const q = new URLSearchParams({
      from: params.from,
      to: params.to,
      date: params.date,
      passengers: String(params.passengers != null ? params.passengers : 1),
      type: String(params.type != null ? params.type : '2'),
    });
    if (params.returnDate) q.set('returnDate', params.returnDate);
    return fetch('/api/flights?' + q.toString(), { signal: signal }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error(String((data && (data.error || data.message))) || 'Flight search failed');
        }
        return data;
      });
    });
  }

  global.__serpFlightsHelpers = {
    escapeHtml: escapeHtml,
    mergeSerpLists: mergeSerpLists,
    fetchSerpFlights: fetchSerpFlights,
    renderSerpFlightListItems: renderSerpFlightListItems,
    bookUrlFromResponse: bookUrlFromResponse,
    serializeForItinerary: serializeForItinerary,
  };
})(typeof window !== 'undefined' ? window : this);
