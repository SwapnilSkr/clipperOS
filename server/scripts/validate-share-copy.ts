import {
  sanitizeShareDescription,
  sanitizeShareTitle,
  stripShowPrefix,
} from "../src/services/share-copy.service";

function check(name: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

check(
  "title drops hashtags",
  sanitizeShareTitle("Mark talks #Shorts about ads", "Fallback") === "Mark talks about ads"
);
check(
  "banned clickbait falls back",
  sanitizeShareTitle("You won't believe this moment", "Mark explains ads") === "Mark explains ads"
);
check("title is capped at 100", sanitizeShareTitle("M".repeat(140), "Clip").length <= 100);
check(
  "all-caps is retitled",
  sanitizeShareTitle("MARK ZUCKERBERG TALKS ADS", "Fallback") === "Mark Zuckerberg Talks Ads"
);
check(
  "description strips urls",
  !sanitizeShareDescription("See https://youtu.be/abc full talk.", "Fallback").includes("http")
);
check(
  "empty description still produces paste copy",
  sanitizeShareDescription("   ", "Lead line").includes("Lead line")
);
check(
  "description keeps a credit line",
  sanitizeShareDescription(
    "Mark explains WhatsApp encryption.\n\n#WhatsApp",
    "Fallback",
    { channelTitle: "Sources Podcast", transcript: "We designed WhatsApp so even Meta cannot read the messages people send." }
  ).includes("Full conversation on the channel.")
);
check(
  "a long first line is cut on a sentence",
  sanitizeShareDescription(
    `${"Mark Zuckerberg explains encryption. Then he keeps talking about trust and WhatsApp at length. ".repeat(4)}\n\n#Privacy`,
    "Fallback",
    { channelTitle: "Sources Podcast" }
  ).startsWith("Mark Zuckerberg explains encryption.")
);
check(
  "short description is filled from the transcript",
  sanitizeShareDescription("Mark on encryption.", "Mark on encryption.", {
    channelTitle: "Sources Podcast",
    transcript:
      "We designed WhatsApp so even Meta cannot read the messages people send. That is why people trust the product.",
    name: "Mark Zuckerberg",
  }).length >= 180
);
check(
  "show-name colon prefix is stripped",
  stripShowPrefix("Sources Podcast: Mark explains ads", "Sources Podcast") === "Mark explains ads"
);

console.log("share-copy checks passed");
