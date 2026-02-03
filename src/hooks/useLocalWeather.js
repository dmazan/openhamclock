/**
 * useLocalWeather Hook
 * Fetches detailed weather data from Open-Meteo API (free, no API key)
 */
import { useState, useEffect } from 'react';

// Weather code to description and icon mapping
const WEATHER_CODES = {
  0: { desc: 'Clear sky', icon: '☀️' },
  1: { desc: 'Mainly clear', icon: '🌤️' },
  2: { desc: 'Partly cloudy', icon: '⛅' },
  3: { desc: 'Overcast', icon: '☁️' },
  45: { desc: 'Fog', icon: '🌫️' },
  48: { desc: 'Depositing rime fog', icon: '🌫️' },
  51: { desc: 'Light drizzle', icon: '🌧️' },
  53: { desc: 'Moderate drizzle', icon: '🌧️' },
  55: { desc: 'Dense drizzle', icon: '🌧️' },
  56: { desc: 'Light freezing drizzle', icon: '🌧️' },
  57: { desc: 'Dense freezing drizzle', icon: '🌧️' },
  61: { desc: 'Slight rain', icon: '🌧️' },
  63: { desc: 'Moderate rain', icon: '🌧️' },
  65: { desc: 'Heavy rain', icon: '🌧️' },
  66: { desc: 'Light freezing rain', icon: '🌧️' },
  67: { desc: 'Heavy freezing rain', icon: '🌧️' },
  71: { desc: 'Slight snow', icon: '🌨️' },
  73: { desc: 'Moderate snow', icon: '🌨️' },
  75: { desc: 'Heavy snow', icon: '❄️' },
  77: { desc: 'Snow grains', icon: '🌨️' },
  80: { desc: 'Slight rain showers', icon: '🌦️' },
  81: { desc: 'Moderate rain showers', icon: '🌦️' },
  82: { desc: 'Violent rain showers', icon: '⛈️' },
  85: { desc: 'Slight snow showers', icon: '🌨️' },
  86: { desc: 'Heavy snow showers', icon: '❄️' },
  95: { desc: 'Thunderstorm', icon: '⛈️' },
  96: { desc: 'Thunderstorm w/ slight hail', icon: '⛈️' },
  99: { desc: 'Thunderstorm w/ heavy hail', icon: '⛈️' }
};

// Wind direction from degrees
function windDirection(deg) {
  if (deg == null) return '';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

export const useLocalWeather = (location, tempUnit = 'F') => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!location?.lat || !location?.lon) return;

    const fetchWeather = async () => {
      try {
        const isMetric = tempUnit === 'C';
        const params = [
          `latitude=${location.lat}`,
          `longitude=${location.lon}`,
          'current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,uv_index,visibility,dew_point_2m,is_day',
          'daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weather_code,sunrise,sunset,uv_index_max,wind_speed_10m_max',
          'hourly=temperature_2m,precipitation_probability,weather_code',
          `temperature_unit=${isMetric ? 'celsius' : 'fahrenheit'}`,
          `wind_speed_unit=${isMetric ? 'kmh' : 'mph'}`,
          `precipitation_unit=${isMetric ? 'mm' : 'inch'}`,
          'timezone=auto',
          'forecast_days=3',
          'forecast_hours=24',
        ].join('&');
        
        const url = `https://api.open-meteo.com/v1/forecast?${params}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        
        const current = result.current || {};
        const code = current.weather_code;
        const weather = WEATHER_CODES[code] || { desc: 'Unknown', icon: '🌡️' };
        const daily = result.daily || {};
        const hourly = result.hourly || {};
        
        // Build hourly forecast (next 24h in 3h intervals)
        const hourlyForecast = [];
        if (hourly.time && hourly.temperature_2m) {
          for (let i = 0; i < Math.min(24, hourly.time.length); i += 3) {
            const hCode = hourly.weather_code?.[i];
            const hWeather = WEATHER_CODES[hCode] || { desc: '', icon: '🌡️' };
            hourlyForecast.push({
              time: new Date(hourly.time[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
              temp: Math.round(hourly.temperature_2m[i]),
              precipProb: hourly.precipitation_probability?.[i] || 0,
              icon: hWeather.icon,
            });
          }
        }
        
        // Build daily forecast
        const dailyForecast = [];
        if (daily.time) {
          for (let i = 0; i < Math.min(3, daily.time.length); i++) {
            const dCode = daily.weather_code?.[i];
            const dWeather = WEATHER_CODES[dCode] || { desc: '', icon: '🌡️' };
            dailyForecast.push({
              date: new Date(daily.time[i] + 'T12:00:00').toLocaleDateString([], { weekday: 'short' }),
              high: Math.round(daily.temperature_2m_max?.[i] || 0),
              low: Math.round(daily.temperature_2m_min?.[i] || 0),
              precipProb: daily.precipitation_probability_max?.[i] || 0,
              precipSum: daily.precipitation_sum?.[i] || 0,
              icon: dWeather.icon,
              desc: dWeather.desc,
              windMax: Math.round(daily.wind_speed_10m_max?.[i] || 0),
              uvMax: daily.uv_index_max?.[i] || 0,
            });
          }
        }
        
        setData({
          // Current conditions
          temp: Math.round(current.temperature_2m || 0),
          feelsLike: Math.round(current.apparent_temperature || 0),
          description: weather.desc,
          icon: weather.icon,
          humidity: Math.round(current.relative_humidity_2m || 0),
          dewPoint: Math.round(current.dew_point_2m || 0),
          pressure: current.pressure_msl ? current.pressure_msl.toFixed(1) : null,
          cloudCover: current.cloud_cover || 0,
          windSpeed: Math.round(current.wind_speed_10m || 0),
          windDir: windDirection(current.wind_direction_10m),
          windDirDeg: current.wind_direction_10m || 0,
          windGusts: Math.round(current.wind_gusts_10m || 0),
          precipitation: current.precipitation || 0,
          uvIndex: current.uv_index || 0,
          visibility: current.visibility 
            ? isMetric 
              ? (current.visibility / 1000).toFixed(1)  // meters to km
              : (current.visibility / 1609.34).toFixed(1) // meters to miles
            : null,
          isDay: current.is_day === 1,
          weatherCode: code,
          // Today's highs/lows
          todayHigh: daily.temperature_2m_max?.[0] ? Math.round(daily.temperature_2m_max[0]) : null,
          todayLow: daily.temperature_2m_min?.[0] ? Math.round(daily.temperature_2m_min[0]) : null,
          // Forecasts
          hourly: hourlyForecast,
          daily: dailyForecast,
          // Timezone
          timezone: result.timezone || '',
          // Units
          tempUnit: isMetric ? 'C' : 'F',
          windUnit: isMetric ? 'km/h' : 'mph',
          visUnit: isMetric ? 'km' : 'mi',
        });
      } catch (err) {
        console.error('Weather error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchWeather();
    const interval = setInterval(fetchWeather, 15 * 60 * 1000); // 15 minutes
    return () => clearInterval(interval);
  }, [location?.lat, location?.lon, tempUnit]);

  return { data, loading };
};

export default useLocalWeather;
