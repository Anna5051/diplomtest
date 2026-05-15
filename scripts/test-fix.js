function balanceGuillemets(paragraph) {
  let open = 0;
  let out = "";
  for (const ch of String(paragraph || "")) {
    if (ch === "«") {
      if (open > 0) continue;
      open = 1;
      out += ch;
    } else if (ch === "»") {
      if (open === 0) continue;
      open = 0;
      out += ch;
    } else {
      out += ch;
    }
  }
  if (open > 0) out += "»";
  return out;
}

function fixMalformedGuillemets(text) {
  let p = String(text || "");
  const steps = [];
  const run = (name, fn) => {
    p = fn(p);
    steps.push([name, p]);
  };
  run("0", (x) => x);
  run("empty", (x) => x.replace(/«\s*»+/g, ""));
  run("42", (x) => x.replace(/»{2,}/g, "»"));
  run("43", (x) => x.replace(/([.!?…])\s*»+\s*(?=[А-ЯЁ])/gu, "$1 "));
  run("50", (x) => x.replace(/([а-яё]{2,})\s+«([а-яё])/gu, "$1 $2"));
  run("balance", balanceGuillemets);
  for (const [n, v] of steps) {
    if (v !== steps[steps.findIndex((s) => s[0] === "0")][1]) {
      console.log(n + ":", v);
    }
  }
}

const s = "*она произнесла* «Отпустить?» — прошептала она.";
fixMalformedGuillemets(s);
