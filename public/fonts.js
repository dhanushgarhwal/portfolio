// Poppins comes from /font (see state.css). If any file fails to load, the same weights are taken from Google Fonts instead.
const WEIGHTS = [300, 400, 500, 600, 700];
const load = () => Promise.all(WEIGHTS.map((w) => document.fonts.load(`${w} 14px Poppins`, "Aa")));

window.fontsReady = load().catch(() => {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap";
  document.head.append(link);
  return load().catch(() => {});
});
