/**
 * usePOTASpots Hook
 * Fetches Parks on the Air activations via server proxy (for caching)
 */
import { useState, useEffect } from 'react';

export const usePOTASpots = () => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchPOTA = async () => {
      try {
        // Use server proxy for caching - reduces external API calls
        const res = await fetch('/api/pota/spots');
        if (res.ok) {
          const spots = await res.json();
          setData(spots.slice(0, 10).map(s => ({
            call: s.activator, 
            ref: s.reference, 
            freq: s.frequency, 
            mode: s.mode,
            name: s.name || s.locationDesc, 
            lat: s.latitude, 
            lon: s.longitude,
            time: s.spotTime ? new Date(s.spotTime).toISOString().substr(11,5)+'z' : ''
          })));
        }
      } catch (err) { 
        console.error('POTA error:', err); 
      } finally { 
        setLoading(false); 
      }
    };
    
    fetchPOTA();
    const interval = setInterval(fetchPOTA, 2 * 60 * 1000); // 2 minutes
    return () => clearInterval(interval);
  }, []);

  return { data, loading };
};

export default usePOTASpots;
