import React, { useEffect, useMemo, useState } from 'react';

const DIRECTIONS = [
  { value: 'bidirectional', label: 'Wix ↔ HubSpot' },
  { value: 'wixToHubspot', label: 'Wix → HubSpot' },
  { value: 'hubspotToWix', label: 'HubSpot → Wix' },
];
const TRANSFORMS = ['', 'trim', 'lowercase', 'uppercase'];

// Tiny fetch helper that attaches the dashboard API key.
function useApi(apiKey) {
  return useMemo(() => async (path, opts = {}) => {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }, [apiKey]);
}

export default function App() {
  const [apiKey, setApiKey] = useState(localStorage.getItem('apiKey') || '');
  const api = useApi(apiKey);

  const [status, setStatus] = useState(null);
  const [options, setOptions] = useState(null);
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [instanceId, setInstanceId] = useState('');

  async function loadAll() {
    setErr(''); setMsg('');
    try {
      const [st, opt, maps] = await Promise.all([
        api('/auth/status'),
        api('/api/mappings/options'),
        api('/api/mappings'),
      ]);
      setStatus(st); setOptions(opt);
      setRows(maps.map((m) => ({ wixField: m.wixField, hubspotProperty: m.hubspotProperty, direction: m.direction, transform: m.transform || '' })));
    } catch (e) { setErr(e.message); }
  }

  useEffect(() => { if (apiKey) loadAll(); }, [apiKey]);

  // Duplicate HubSpot targets are invalid.
  const dupes = useMemo(() => {
    const counts = {};
    rows.forEach((r) => { if (r.hubspotProperty) counts[r.hubspotProperty] = (counts[r.hubspotProperty] || 0) + 1; });
    return new Set(Object.keys(counts).filter((k) => counts[k] > 1));
  }, [rows]);
  const incomplete = rows.some((r) => !r.wixField || !r.hubspotProperty);
  const canSave = rows.length > 0 && dupes.size === 0 && !incomplete;

  function update(i, key, val) { setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: val } : r))); }
  function addRow() { setRows((rs) => [...rs, { wixField: '', hubspotProperty: '', direction: 'bidirectional', transform: '' }]); }
  function removeRow(i) { setRows((rs) => rs.filter((_, idx) => idx !== i)); }

  async function save() {
    setErr(''); setMsg('');
    try {
      await api('/api/mappings', {
        method: 'PUT',
        body: JSON.stringify({ mappings: rows.map((r) => ({ ...r, transform: r.transform || null })) }),
      });
      setMsg('Mapping saved. Sync will use these rules.');
    } catch (e) { setErr(e.message); }
  }

  async function connectWix() {
    setErr(''); setMsg('');
    try {
      await api('/auth/wix/instance', { method: 'POST', body: JSON.stringify({ instanceId: instanceId.trim() }) });
      setInstanceId(''); setMsg('Wix instance registered.'); loadAll();
    } catch (e) { setErr(e.message); }
  }

  async function disconnectWix() {
    try { await api('/auth/wix/disconnect', { method: 'POST' }); loadAll(); }
    catch (e) { setErr(e.message); }
  }

  function saveKey(v) { localStorage.setItem('apiKey', v); setApiKey(v); }

  return (
    <div className="wrap">
      <h1>Wix ↔ HubSpot Sync</h1>
      <p className="sub">Connect HubSpot, map your fields, and keep contacts in sync both ways.</p>

      <div className="keybar">
        <span>Dashboard API key:</span>
        <input type="password" value={apiKey} placeholder="DASHBOARD_API_KEY" onChange={(e) => saveKey(e.target.value)} />
        <button className="ghost" onClick={loadAll}>Reload</button>
      </div>

      {err && <div className="err">{err}</div>}
      {msg && <div className="okmsg">{msg}</div>}

      {/* Connection status */}
      <div className="card">
        <h2>Connections</h2>
        <div className="row" style={{ gap: 24 }}>
          <div className="row">
            <strong>HubSpot</strong>
            <span className={`pill ${status?.hubspotReachable ? 'ok' : 'off'}`}>
              {status?.hubspotReachable ? '● Connected' : '○ Not reachable'}
            </span>
          </div>
          <div className="row">
            <strong>Wix</strong>
            <span className={`pill ${status?.wixConnected ? 'ok' : 'off'}`}>
              {status?.wixConnected ? '● Connected' : '○ Not connected'}
            </span>
            {status?.wixConnected
              ? <button className="danger" onClick={disconnectWix}>Disconnect</button>
              : (
                <>
                  <input style={{ maxWidth: 280 }} placeholder="Wix instanceId" value={instanceId} onChange={(e) => setInstanceId(e.target.value)} />
                  <button className="primary" disabled={!instanceId.trim()} onClick={connectWix}>Connect</button>
                </>
              )}
          </div>
        </div>
        <p className="note">
          HubSpot uses a private-app token stored encrypted on the server (never exposed to the browser).
          Wix uses OAuth 2.0 (client_credentials grant): the site's instanceId is captured by the
          App Instance Installed webhook, then short-lived access tokens are minted on demand. You can
          also paste an instanceId here to connect manually.
        </p>
      </div>

      {/* Field mapping table */}
      <div className="card">
        <h2>Field mapping</h2>
        {!options && <p className="note">Enter your API key above to load fields.</p>}
        {options && (
          <>
            <table>
              <thead>
                <tr>
                  <th style={{ width: '24%' }}>Wix field</th>
                  <th style={{ width: '30%' }}>HubSpot property</th>
                  <th style={{ width: '22%' }}>Direction</th>
                  <th style={{ width: '16%' }}>Transform</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <select value={r.wixField} onChange={(e) => update(i, 'wixField', e.target.value)}>
                        <option value="">—</option>
                        {options.wixFields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
                      </select>
                    </td>
                    <td className={dupes.has(r.hubspotProperty) ? 'bad' : ''}>
                      <select value={r.hubspotProperty} onChange={(e) => update(i, 'hubspotProperty', e.target.value)}>
                        <option value="">—</option>
                        {options.hubspotProperties.map((p) => <option key={p.name} value={p.name}>{p.label} ({p.name})</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={r.direction} onChange={(e) => update(i, 'direction', e.target.value)}>
                        {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={r.transform} onChange={(e) => update(i, 'transform', e.target.value)}>
                        {TRANSFORMS.map((t) => <option key={t} value={t}>{t || 'none'}</option>)}
                      </select>
                    </td>
                    <td><button className="link" onClick={() => removeRow(i)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dupes.size > 0 && <div className="err">Duplicate HubSpot property: {[...dupes].join(', ')}. Each HubSpot property can be mapped once.</div>}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="ghost" onClick={addRow}>+ Add row</button>
              <button className="primary" disabled={!canSave} onClick={save}>Save mapping</button>
            </div>
            <p className="note">Saved rules take effect immediately — no code changes needed.</p>
          </>
        )}
      </div>
    </div>
  );
}
