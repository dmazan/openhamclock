/**
 * useDXPaths Hook
 * Fetches DX spots with coordinates for map visualization
 */
import { useState, useEffect } from 'react';

export const useDXPaths = () => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch('/api/dxcluster/paths');
        if (response.ok) {
          const paths = await response.json();
          setData(paths);
        }
      } catch (err) {
        console.error('DX paths error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000); // 30 seconds (was 10s)
    return () => clearInterval(interval);
  }, []);

  return { data, loading };
};

export default useDXPaths;
