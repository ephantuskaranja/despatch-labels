(() => {
  'use strict';

  const state = {
    requestId: null,
    requestStatus: null,
    crateWeightKg: 1.8,
    scaleSource: null,
    liveWeight: 0,
    stable: false,
    scaleConnected: false,
    capturedGross: null,
    lines: [],
  };

  const ACTIVE_REQUEST_KEY = 'despatch:activeRequestId';

  // ---------- helpers ----------

  const $ = (id) => document.getElementById(id);

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ` ${kind}` : '');
  }

  function fmt(n) {
    const value = Number(n);
    return Number.isFinite(value) ? value.toFixed(1) : '-';
  }

  function toDateInputValue(value) {
    return value ? String(value).slice(0, 10) : '';
  }

  // Best-effort — private browsing / blocked storage should never break the app.
  function saveActiveRequestId(id) {
    try { localStorage.setItem(ACTIVE_REQUEST_KEY, String(id)); } catch (_) { /* ignore */ }
  }
  function clearActiveRequestId() {
    try { localStorage.removeItem(ACTIVE_REQUEST_KEY); } catch (_) { /* ignore */ }
  }
  function getStoredActiveRequestId() {
    try { return localStorage.getItem(ACTIVE_REQUEST_KEY); } catch (_) { return null; }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      payload = null;
    }
    if (!response.ok || (payload && payload.success === false)) {
      throw new Error((payload && payload.message) || `Request failed (${response.status})`);
    }
    return payload;
  }

  // ---------- tabs ----------

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'reports') {
        loadReports();
      }
    });
  });

  // ---------- crate weight setting ----------

  async function loadCrateWeight() {
    try {
      const payload = await api('/api/settings/crate-weight');
      state.crateWeightKg = Number(payload.data.crateWeightKg) || 1.8;
    } catch (_) {
      state.crateWeightKg = 1.8;
    }
    $('crateWeightDisplay').value = state.crateWeightKg.toFixed(2);
    updateNetPreview();
  }

  // ---------- scale connection ----------

  async function loadComPorts() {
    const select = $('comPortSelect');
    const previous = select.value;
    try {
      const payload = await api('/api/get-comport-list');
      select.innerHTML = '';
      if (!payload.response || !payload.response.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No COM ports found';
        select.appendChild(opt);
        return;
      }
      payload.response.forEach((port) => {
        const opt = document.createElement('option');
        opt.value = port;
        opt.textContent = port;
        select.appendChild(opt);
      });
      if (previous && payload.response.includes(previous)) {
        select.value = previous;
      }
    } catch (error) {
      setMsg($('scaleMsg'), `Could not list COM ports: ${error.message}`, 'error');
    }
  }

  function setScaleBadge(mode) {
    const badge = $('scaleBadge');
    badge.className = `badge ${mode}`;
    badge.textContent = {
      offline: 'OFFLINE',
      connecting: 'CONNECTING…',
      live: 'READING…',
      stable: 'STABLE',
    }[mode] || 'OFFLINE';
  }

  function updateWeightDisplay() {
    $('scaleWeight').innerHTML = `${fmt(state.liveWeight)} <small>kg</small>`;
    if (!state.scaleConnected) {
      setScaleBadge('offline');
    } else {
      setScaleBadge(state.stable ? 'stable' : 'live');
    }
  }

  function stopScaleStream() {
    if (state.scaleSource) {
      state.scaleSource.close();
      state.scaleSource = null;
    }
    state.scaleConnected = false;
    updateWeightDisplay();
  }

  function connectScale() {
    const port = $('comPortSelect').value;
    if (!port) {
      setMsg($('scaleMsg'), 'Select a COM port first.', 'error');
      return;
    }
    stopScaleStream();
    setScaleBadge('connecting');
    setMsg($('scaleMsg'), `Connecting to ${port}...`);

    const source = new EventSource(`/api/scale/stream/${encodeURIComponent(port)}`);
    state.scaleSource = source;

    source.addEventListener('connected', () => {
      state.scaleConnected = true;
      setMsg($('scaleMsg'), `Connected to ${port}.`, 'success');
      updateWeightDisplay();
    });

    source.addEventListener('reading', (event) => {
      try {
        const payload = JSON.parse(event.data);
        state.liveWeight = Number(payload.weight) || 0;
        state.stable = Boolean(payload.stable);
        state.scaleConnected = true;
        updateWeightDisplay();
      } catch (_) { /* ignore malformed frame */ }
    });

    source.addEventListener('status', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.success === false) {
          state.scaleConnected = false;
          setMsg($('scaleMsg'), payload.message || 'Scale disconnected.', 'error');
          updateWeightDisplay();
        }
      } catch (_) { /* ignore */ }
    });

    source.addEventListener('error', (event) => {
      state.scaleConnected = false;
      let message = 'Scale stream error.';
      try {
        message = JSON.parse(event.data).message || message;
      } catch (_) { /* not JSON — e.g. transport-level EventSource error */ }
      setMsg($('scaleMsg'), message, 'error');
      updateWeightDisplay();
    });
  }

  $('refreshPortsBtn').addEventListener('click', loadComPorts);
  $('connectScaleBtn').addEventListener('click', connectScale);

  $('manualEntryToggle').addEventListener('change', (e) => {
    $('manualWeightInput').classList.toggle('hidden', !e.target.checked);
    state.capturedGross = null;
    $('capturedGross').textContent = '-';
    updateNetPreview();
  });

  // ---------- carton line capture ----------

  function updateNetPreview() {
    const crateCount = Number($('crateCount').value) || 0;
    if (state.capturedGross === null) {
      $('previewNet').textContent = '-';
      $('addLineBtn').disabled = true;
      return;
    }
    const net = state.capturedGross - (crateCount * state.crateWeightKg);
    $('previewNet').textContent = net > 0 ? net.toFixed(1) : '0.0';
    $('addLineBtn').disabled = !(net > 0 && state.requestId && state.requestStatus === 'OPEN');
  }

  $('crateCount').addEventListener('input', updateNetPreview);

  $('captureWeightBtn').addEventListener('click', () => {
    if ($('manualEntryToggle').checked) {
      const manual = Number($('manualWeightInput').value);
      if (!Number.isFinite(manual) || manual <= 0) {
        setMsg($('lineMsg'), 'Enter a valid manual weight first.', 'error');
        return;
      }
      state.capturedGross = manual;
    } else {
      if (!state.scaleConnected) {
        setMsg($('lineMsg'), 'Scale is not connected. Connect it or use manual entry.', 'error');
        return;
      }
      if (!state.stable) {
        setMsg($('lineMsg'), 'Reading is not stable yet — hold the load still and try again.', 'error');
        return;
      }
      state.capturedGross = state.liveWeight;
    }
    $('capturedGross').textContent = state.capturedGross.toFixed(1);
    setMsg($('lineMsg'), '');
    updateNetPreview();
  });

  $('addLineBtn').addEventListener('click', async () => {
    if (!state.requestId) {
      setMsg($('lineMsg'), 'Save the request header first.', 'error');
      return;
    }
    const cartonNo = $('cartonNo').value.trim();
    const productDescription = $('productDescription').value.trim();
    if (!cartonNo || !productDescription) {
      setMsg($('lineMsg'), 'Carton No. and Product Description are required.', 'error');
      return;
    }
    if (state.capturedGross === null) {
      setMsg($('lineMsg'), 'Capture a weight before adding the line.', 'error');
      return;
    }

    try {
      const payload = await api(`/api/requests/${state.requestId}/lines`, {
        method: 'POST',
        body: JSON.stringify({
          cartonNo,
          productDescription,
          grossWeightKg: state.capturedGross,
          crateCount: Number($('crateCount').value) || 0,
          productionDate: $('productionDate').value || null,
          expiryDate: $('expiryDate').value || null,
        }),
      });
      state.lines.push(payload.data);
      renderLines();
      resetLineEntry();
      setMsg($('lineMsg'), 'Line added.', 'success');
      $('completeBtn').disabled = false;
    } catch (error) {
      setMsg($('lineMsg'), error.message, 'error');
    }
  });

  // Carton No. and the captured weight are unique per carton, so those clear
  // on every add. Product Description, Production Date and Expiry Date tend
  // to repeat across a run of cartons for the same customer/batch (see the
  // paper form), so they're deliberately left as-is for the next line.
  function resetLineEntry() {
    $('cartonNo').value = '';
    $('manualWeightInput').value = '';
    state.capturedGross = null;
    $('capturedGross').textContent = '-';
    updateNetPreview();
    $('cartonNo').focus();
  }

  function renderLines() {
    const tbody = document.querySelector('#linesTable tbody');
    tbody.innerHTML = '';
    let totalGross = 0;
    let totalNet = 0;

    state.lines.forEach((line) => {
      totalGross += Number(line.gross_weight_kg);
      totalNet += Number(line.net_weight_kg);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${line.line_no}</td>
        <td>${escapeHtml(line.carton_no)}</td>
        <td>${escapeHtml(line.product_description)}</td>
        <td>${fmt(line.gross_weight_kg)}</td>
        <td>${line.crate_count}</td>
        <td>${fmt(line.net_weight_kg)}</td>
        <td>${toDateInputValue(line.production_date) || '-'}</td>
        <td>${toDateInputValue(line.expiry_date) || '-'}</td>
        <td><button class="row-remove" data-line-id="${line.id}">Remove</button></td>
      `;
      tbody.appendChild(tr);
    });

    $('totalGross').textContent = fmt(totalGross);
    $('totalNet').textContent = fmt(totalNet);
    $('lineCount').textContent = state.lines.length ? `(${state.lines.length})` : '';

    tbody.querySelectorAll('.row-remove').forEach((btn) => {
      btn.addEventListener('click', () => removeLine(btn.dataset.lineId));
    });
  }

  async function removeLine(lineId) {
    if (!state.requestId) return;
    try {
      await api(`/api/requests/${state.requestId}/lines/${lineId}`, { method: 'DELETE' });
      state.lines = state.lines.filter((line) => String(line.id) !== String(lineId));
      renderLines();
      $('completeBtn').disabled = state.lines.length === 0;
    } catch (error) {
      setMsg($('lineMsg'), error.message, 'error');
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  // ---------- header save / complete ----------

  function collectHeaderPayload() {
    return {
      labelsRequestedBy: $('labelsRequestedBy').value.trim(),
      labelsAppliedBy: $('labelsAppliedBy').value.trim(),
      labelsPrintedBy: $('labelsPrintedBy').value.trim(),
      customerName: $('customerName').value.trim(),
      customerReferenceNo: $('customerReferenceNo').value.trim(),
      airwayBillNo: $('airwayBillNo').value.trim(),
      requestDate: $('requestDate').value || null,
    };
  }

  function setStatusPill(status) {
    const pill = $('requestStatus');
    pill.classList.remove('hidden');
    pill.textContent = status;
    pill.className = `status-pill ${status.toLowerCase()}`;
  }

  // Populates the whole New Request tab (header fields, lines, buttons) from a
  // request returned by the API — used both after a save and when resuming an
  // OPEN request (auto, on page load, or picked from the resume panel).
  function applyRequestToState(request) {
    state.requestId = request.id;
    state.requestStatus = request.status;
    state.lines = request.lines || [];

    $('labelsRequestedBy').value = request.labels_requested_by || '';
    $('labelsAppliedBy').value = request.labels_applied_by || '';
    $('labelsPrintedBy').value = request.labels_printed_by || '';
    $('customerName').value = request.customer_name || '';
    $('customerReferenceNo').value = request.customer_reference_no || '';
    $('airwayBillNo').value = request.airway_bill_no || '';
    $('requestDate').value = toDateInputValue(request.request_date);

    setStatusPill(state.requestStatus);
    renderLines();
    updateNetPreview();

    const isOpen = state.requestStatus === 'OPEN';
    $('completeBtn').disabled = !isOpen || state.lines.length === 0;
    $('addLineBtn').disabled = true; // re-enabled by updateNetPreview() once a weight is captured
    $('saveHeaderBtn').textContent = isOpen ? 'Save Request' : 'Start New Request';

    if (isOpen) {
      saveActiveRequestId(state.requestId);
    } else {
      clearActiveRequestId();
    }
  }

  $('saveHeaderBtn').addEventListener('click', async () => {
    if (state.requestId && state.requestStatus === 'COMPLETED') {
      // Start a fresh request.
      window.location.reload();
      return;
    }

    const payload = collectHeaderPayload();
    try {
      const response = state.requestId
        ? await api(`/api/requests/${state.requestId}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : await api('/api/requests', { method: 'POST', body: JSON.stringify(payload) });

      applyRequestToState(response.data);
      setMsg($('headerMsg'), `Request #${state.requestId} saved.`, 'success');
      loadOpenRequestsPicker();
    } catch (error) {
      setMsg($('headerMsg'), error.message, 'error');
    }
  });

  $('completeBtn').addEventListener('click', async () => {
    if (!state.requestId) return;
    try {
      const response = await api(`/api/requests/${state.requestId}/complete`, { method: 'POST' });
      applyRequestToState(response.data);
      setMsg($('headerMsg'), `Request #${state.requestId} completed.`, 'success');
      loadOpenRequestsPicker();
    } catch (error) {
      setMsg($('headerMsg'), error.message, 'error');
    }
  });

  // ---------- resume an open request ----------

  async function loadOpenRequestsPicker() {
    const panel = $('resumePanel');
    const select = $('resumeSelect');
    try {
      const payload = await api('/api/requests?status=OPEN&pageSize=50');
      const openRequests = payload.data || [];

      if (!openRequests.length) {
        panel.classList.add('hidden');
        return;
      }

      select.innerHTML = '';
      openRequests.forEach((request) => {
        const opt = document.createElement('option');
        opt.value = request.id;
        opt.textContent = `#${request.id} — ${request.customer_name} — requested by ${request.labels_requested_by} — ${request.lineCount} line(s)`;
        select.appendChild(opt);
      });
      if (state.requestId) {
        select.value = String(state.requestId);
      }
      panel.classList.remove('hidden');
    } catch (_) {
      // Non-critical — leave the panel as-is (likely hidden) if this fails.
    }
  }

  async function resumeRequestById(id, { auto = false } = {}) {
    try {
      const payload = await api(`/api/requests/${id}`);
      if (payload.data.status !== 'OPEN') {
        clearActiveRequestId();
        return;
      }
      applyRequestToState(payload.data);
      setMsg($('resumeMsg'), `Resumed request #${payload.data.id}.`, 'success');
      if (!auto) {
        setMsg($('headerMsg'), `Resumed request #${payload.data.id}.`, 'success');
      }
    } catch (error) {
      clearActiveRequestId();
      if (!auto) {
        setMsg($('resumeMsg'), error.message, 'error');
      }
    }
  }

  $('resumeBtn').addEventListener('click', () => {
    const id = $('resumeSelect').value;
    if (id) {
      resumeRequestById(id);
    }
  });

  $('startBlankBtn').addEventListener('click', () => {
    clearActiveRequestId();
    window.location.reload();
  });

  // ---------- reports ----------

  function buildFilterQuery() {
    const params = new URLSearchParams();
    const from = $('filterFrom').value;
    const to = $('filterTo').value;
    const customerName = $('filterCustomer').value.trim();
    const requestedBy = $('filterRequestedBy').value.trim();
    const airwayBillNo = $('filterAirwayBill').value.trim();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (customerName) params.set('customerName', customerName);
    if (requestedBy) params.set('requestedBy', requestedBy);
    if (airwayBillNo) params.set('airwayBillNo', airwayBillNo);
    return params;
  }

  async function loadReports() {
    const tbody = document.querySelector('#reportsTable tbody');
    setMsg($('reportsMsg'), 'Loading...');
    try {
      const params = buildFilterQuery();
      params.set('pageSize', '100');
      const payload = await api(`/api/requests?${params.toString()}`);
      tbody.innerHTML = '';
      payload.data.forEach((row) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${row.id}</td>
          <td>${row.request_date || '-'}</td>
          <td>${row.status}</td>
          <td>${escapeHtml(row.labels_requested_by)}</td>
          <td>${escapeHtml(row.customer_name)}</td>
          <td>${escapeHtml(row.airway_bill_no || '-')}</td>
          <td>${row.lineCount}</td>
          <td>${fmt(row.netWeightTotal)}</td>
          <td>
            <a href="/api/requests/${row.id}/pdf" target="_blank">PDF</a> ·
            <a href="/api/requests/${row.id}/excel" target="_blank">Excel</a>
          </td>
        `;
        tbody.appendChild(tr);
      });
      setMsg($('reportsMsg'), `${payload.total} request(s) found.`);
    } catch (error) {
      setMsg($('reportsMsg'), error.message, 'error');
    }
  }

  $('applyFilterBtn').addEventListener('click', loadReports);
  $('clearFilterBtn').addEventListener('click', () => {
    ['filterFrom', 'filterTo', 'filterCustomer', 'filterRequestedBy', 'filterAirwayBill'].forEach((id) => { $(id).value = ''; });
    loadReports();
  });
  $('exportAllBtn').addEventListener('click', () => {
    const params = buildFilterQuery();
    window.open(`/api/requests/export/excel?${params.toString()}`, '_blank');
  });

  // ---------- init ----------

  async function init() {
    $('requestDate').value = new Date().toISOString().slice(0, 10);
    loadCrateWeight();
    loadComPorts();
    updateWeightDisplay();
    updateNetPreview();

    await loadOpenRequestsPicker();

    const storedId = getStoredActiveRequestId();
    if (storedId) {
      await resumeRequestById(storedId, { auto: true });
    }
  }

  init();
})();
