// A classic script in <head>, so the saved theme applies before the first paint and never flashes.
// Settings (settings.js) changes it and uses the same storage key.
try {
  const theme = localStorage.getItem('branch-graph:theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* storage unavailable: follow the system */ }
