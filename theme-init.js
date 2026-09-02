// Runs in <head>, before body content paints, so a saved theme choice
// applies immediately instead of flashing the OS-default theme first.
// MV3 CSP forbids inline scripts, which is why this is its own tiny file.
(function () {
  try {
    var saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.dataset.theme = saved;
    }
  } catch (e) {
    // localStorage can throw in some restricted contexts — fall back to OS theme.
  }
})();
