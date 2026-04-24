import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Search, Download, Loader2, Trash2, Navigation, Star, Zap, Layers, 
  ChevronDown, ChevronUp, CheckSquare, Square, Tag, MapPin, MessageSquare, Info as InfoIcon
} from 'lucide-react';
import Papa from 'papaparse';
import MapSelector from './components/MapSelector';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function App() {
  const [activeTab, setActiveTab] = useState('quick');
  const [center, setCenter] = useState(() => JSON.parse(localStorage.getItem('scrape_center')) || null);
  const [radius, setRadius] = useState(() => parseInt(localStorage.getItem('scrape_radius')) || 1000);
  const [keyword, setKeyword] = useState(() => localStorage.getItem('scrape_keyword') || 'ALFAMART');
  const [addressSearch, setAddressSearch] = useState('');
  
  const [quickResults, setQuickResults] = useState(() => JSON.parse(localStorage.getItem('quick_results')) || []);
  const [deepResults, setDeepResults] = useState(() => JSON.parse(localStorage.getItem('deep_results')) || []);
  
  const [loading, setLoading] = useState(false);
  const [progressInfo, setProgressInfo] = useState({ current: 0, total: 0, status: 'idle' });
  const [maxItems, setMaxItems] = useState(20);
  const [expandedRow, setExpandedRow] = useState(null);
  const [backendStatus, setBackendStatus] = useState('...');

  const [deepOptions, setDeepOptions] = useState({
    rating: true, category: true, address: true, phone: true, website: true, about: false
  });

  useEffect(() => {
    localStorage.setItem('scrape_center', JSON.stringify(center));
    localStorage.setItem('scrape_radius', radius.toString());
    localStorage.setItem('scrape_keyword', keyword);
    localStorage.setItem('quick_results', JSON.stringify(quickResults));
    localStorage.setItem('deep_results', JSON.stringify(deepResults));
  }, [center, radius, keyword, quickResults, deepResults]);

  useEffect(() => {
    const checkBackend = async () => {
      try {
        const res = await fetch(`${API_URL}/ping`);
        setBackendStatus(res.ok ? 'ONLINE' : 'OFFLINE');
      } catch { setBackendStatus('OFFLINE'); }
    };
    checkBackend();
    const interval = setInterval(checkBackend, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (loading) {
      const eventSource = new EventSource(`${API_URL}/progress`);
      eventSource.onmessage = (e) => setProgressInfo(JSON.parse(e.data));
      return () => eventSource.close();
    }
  }, [loading]);

  const handleStartScrape = async () => {
    if (!center) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          lat: center.lat, lng: center.lng, radius, keyword, limit: maxItems,
          type: activeTab, options: activeTab === 'deep' ? deepOptions : {} 
        })
      });
      const data = await response.json();
      
      if (activeTab === 'quick') setQuickResults(data);
      else setDeepResults(data);
    } catch (err) { alert('Error: ' + err.message); } finally { setLoading(false); }
  };

  const exportCSV = (data) => {
    const csv = Papa.unparse(data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `SCRAPE_${activeTab.toUpperCase()}_${keyword}.csv`;
    link.click();
  };

  const handleJumpToLocation = async () => {
    if (!addressSearch) return;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressSearch)}`);
      const data = await res.json();
      if (data?.[0]) setCenter({ lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) });
    } catch { alert('Location not found.'); }
  };

  return (
    <div className="app-container">
      <AnimatePresence>
        {loading && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.96)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'white', backdropFilter: 'blur(12px)' }}>
            <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }} style={{ marginBottom: '40px' }}><Loader2 size={80} style={{ strokeWidth: 1 }} /></motion.div>
            <h2 style={{ fontSize: '24px', fontWeight: 900 }}>{activeTab.toUpperCase()} EXTRACTION</h2>
            <div style={{ fontSize: '14px', fontWeight: 800 }}>ITEM {progressInfo.current} OF {progressInfo.total}</div>
            <div style={{ width: '300px', height: '1px', background: '#333', marginTop: '40px' }}>
              <motion.div animate={{ width: `${(progressInfo.current / (progressInfo.total || 1)) * 100}%` }} style={{ height: '100%', background: '#fff' }} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <header>
        <div className="header-title">GMaps Data Scrapper</div>
        <div className={`status-badge ${backendStatus === 'ONLINE' ? 'status-online' : 'status-offline'}`}>ENGINE {backendStatus}</div>
      </header>

      <div className="top-section" style={{ height: '800px', display: 'grid', gridTemplateColumns: '300px 1fr', gap: '20px' }}>
        <aside className="sidebar" style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingRight: '10px' }}>
          <div style={{ display: 'flex', gap: '4px', background: '#eee', padding: '4px', borderRadius: '4px', marginBottom: '20px', flexShrink: 0 }}>
            <button onClick={() => setActiveTab('quick')} className={`btn-ui ${activeTab === 'quick' ? 'btn-ui-active' : ''}`} style={{ flex: 1, padding: '8px', fontSize: '10px' }}><Zap size={12}/> QUICK</button>
            <button onClick={() => setActiveTab('deep')} className={`btn-ui ${activeTab === 'deep' ? 'btn-ui-active' : ''}`} style={{ flex: 1, padding: '8px', fontSize: '10px' }}><Layers size={12}/> DEEP</button>
          </div>

          <div className="section-group">
            <div className="section-label">Target Area</div>
            <div className="ui-input-wrapper">
              <Navigation size={14} color="#666" />
              <input type="text" value={addressSearch} placeholder="Jump to address..." onChange={(e) => setAddressSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleJumpToLocation()}/>
            </div>
          </div>

          <div className="section-group">
            <div className="section-label">Query</div>
            <div className="ui-input-wrapper"><Search size={14} color="#666" /><input type="text" value={keyword} onChange={(e) => setKeyword(e.target.value.toUpperCase())}/></div>
          </div>

          <div className="section-group">
            <div className="section-label">Radius</div>
            <div className="ui-card">
              <div style={{display:'flex', justifyContent:'space-between', marginBottom:'8px', fontSize:'10px', fontWeight:800}}><span>DISTANCE</span><span>{radius}M</span></div>
              <input type="range" min="100" max="5000" step="100" value={radius} onChange={(e) => setRadius(parseInt(e.target.value))}/>
            </div>
          </div>

          <div className="section-group">
            <div className="section-label">Item Limit</div>
            <div className="ui-card">
              <div style={{display:'flex', justifyContent:'space-between', marginBottom:'8px', fontSize:'10px', fontWeight:800}}><span>MAX ITEMS</span><span>{maxItems}</span></div>
              <input type="range" min="1" max="50" value={maxItems} onChange={(e) => setMaxItems(parseInt(e.target.value))}/>
            </div>
          </div>

          {activeTab === 'deep' && (
            <div className="section-group">
              <div className="section-label">Deep Extraction Options</div>
              <div className="ui-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {Object.keys(deepOptions).map(key => (
                  <div key={key} onClick={() => setDeepOptions(prev => ({...prev, [key]: !prev[key]}))} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontSize: '10px', fontWeight: 800 }}>
                    {deepOptions[key] ? <CheckSquare size={14} fill="#000" color="#fff"/> : <Square size={14} color="#ddd"/>}
                    <span style={{ color: deepOptions[key] ? '#000' : '#999' }}>{key.toUpperCase()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button onClick={handleStartScrape} disabled={loading || !center} className="btn-ui btn-ui-active" style={{padding: '16px', marginTop: 'auto', fontSize: '11px', flexShrink: 0}}>START EXTRACTION</button>
        </aside>

        <main className="map-area" style={{ height: '100%' }}>
          <MapSelector center={center} radius={radius} onLocationSelect={setCenter} />
        </main>
      </div>

      <div className="bottom-section">
        <div className="section-group">
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'16px'}}>
            <div className="section-label" style={{margin:0}}>{activeTab.toUpperCase()} RESULTS</div>
            {(activeTab === 'quick' ? quickResults : deepResults).length > 0 && (
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => exportCSV(activeTab === 'quick' ? quickResults : deepResults)} className="btn-ui btn-ui-active"><Download size={14}/> EXPORT CSV</button>
                <button onClick={() => activeTab === 'quick' ? setQuickResults([]) : setDeepResults([])} className="btn-ui" style={{color:'red'}}><Trash2 size={14}/></button>
              </div>
            )}
          </div>
          
          <div className="ui-table-wrapper">
            <table>
              <thead><tr><th>Place Name</th><th>Rating</th><th>Address</th>{activeTab === 'deep' && <th>Details</th>}</tr></thead>
              <tbody>
                {(activeTab === 'quick' ? quickResults : deepResults).length > 0 ? (
                  (activeTab === 'quick' ? quickResults : deepResults).map((item, idx) => (
                    <React.Fragment key={idx}>
                      <tr>
                        <td style={{fontWeight: 800, fontSize: '12px'}}>{item.name}</td>
                        <td><div style={{display:'flex', alignItems:'center', gap: '4px'}}><Star size={10} fill="#000"/> {item.rating}</div></td>
                        <td style={{fontSize:'11px', color:'#444'}}>{item.address}</td>
                        {activeTab === 'deep' && (
                          <td>
                            <button onClick={() => setExpandedRow(expandedRow === idx ? null : idx)} className="btn-ui" style={{padding: '4px 10px'}}>
                              {expandedRow === idx ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}
                            </button>
                          </td>
                        )}
                      </tr>
                      {activeTab === 'deep' && expandedRow === idx && (
                        <tr>
                          <td colSpan="4" style={{ padding: '24px', background: '#f9f9f9', borderBottom: '2px solid #000' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '11px' }}>
                                {item.phone && <div><b>PHONE:</b> {item.phone}</div>}
                                {item.website && <div><b>WEBSITE:</b> {item.website}</div>}
                                {item.category && <div><b>CATEGORY:</b> {item.category}</div>}
                                {item.about && (
                                  <div style={{ marginTop: '10px', padding: '10px', background: '#fff', border: '1px solid #ddd', borderRadius: '4px' }}>
                                    <div style={{ fontWeight: 800, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}><InfoIcon size={12}/> ABOUT / FACILITIES</div>
                                    <div style={{ color: '#666', lineHeight: '1.4' }}>{item.about}</div>
                                  </div>
                                )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))
                ) : (
                  <tr><td colSpan="4" style={{padding:'100px 0', textAlign:'center', opacity:0.3, fontWeight:800, fontSize:'10px'}}>NO DATA AVAILABLE</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
