(function (global) {
  var configured =
    typeof global.__API_BASE__ === "string" ? global.__API_BASE__.trim() : "";
  var origin =
    global.location && global.location.origin ? global.location.origin : "";
  var isLocalHost =
    global.location &&
    /^(localhost|127\.0\.0\.1)$/i.test(String(global.location.hostname || ""));

  if (configured) {
    global.API_BASE = configured.replace(/\/$/, "");
    return;
  }
  if (isLocalHost) {
    global.API_BASE = "http://localhost:3000";
    return;
  }
  global.API_BASE = origin.replace(/\/$/, "");
})(typeof window !== "undefined" ? window : global);
