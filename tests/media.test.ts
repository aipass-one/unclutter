import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { collectCandidates, createCleaner, matchingElements } from "../lib/dom";
import type { Rule } from "../lib/model";

const doc = (html: string) =>
  new JSDOM(html, { url: "https://www.youtube.com/watch?v=fixture" }).window.document;
const rule = (selector: string): Rule => ({ selector, category: "ad", enabled: true });
const player = `
  <div id="movie_player" class="html5-video-player ad-showing">
    <video></video>
    <div class="video-ads ytp-ad-module">
      <div class="ytp-ad-skip-button-container">
        <button class="ytp-skip-ad-button"><div class="ytp-ad-text">Skip ad</div></button>
      </div>
    </div>
    <div class="ytp-chrome-bottom"><button>Pause</button></div>
  </div>`;

test("YouTube player controls are excluded while unrelated page ads remain eligible", () => {
  const d = doc(`<div class="ad-wrapper">${player}</div><div class="ad-banner">Sponsor</div>`);
  assert.deepEqual(
    collectCandidates(d).map((candidate) => candidate.selector),
    ["div.ad-banner"],
  );
});

test("cached rules cannot hide the player, its ancestors, or nested skip controls", () => {
  const d = doc(`<div class="ad-wrapper">${player}</div><div class="ad-banner">Sponsor</div>`);
  const unsafe = [
    "div.ad-wrapper",
    "div#movie_player",
    "div.video-ads",
    "div.ytp-ad-skip-button-container",
    "button.ytp-skip-ad-button",
    "div.ytp-ad-text",
    "div.ytp-chrome-bottom",
  ];
  for (const selector of unsafe) assert.deepEqual(matchingElements(d, selector), [], selector);
  const cleaner = createCleaner(d);
  assert.equal(cleaner.apply([...unsafe.map(rule), rule("div.ad-banner")]), 1);
  assert.doesNotMatch(d.querySelector(".ad-wrapper")!.outerHTML, /data-unclutter-/);
  assert.equal((d.querySelector(".ad-banner") as HTMLElement).style.display, "none");
});

test("empty YouTube player shells remain protected before video and skip controls arrive", () => {
  for (const shell of [
    '<div id="movie_player"><div class="video-ads"></div></div>',
    '<div class="html5-video-player"><div class="video-ads"></div></div>',
    '<ytd-player><div class="video-ads"></div></ytd-player>',
    '<ytm-player><div class="video-ads"></div></ytm-player>',
  ]) {
    const d = doc(shell);
    const cleaner = createCleaner(d);
    assert.deepEqual(collectCandidates(d), [], shell);
    assert.equal(cleaner.apply([rule("div.video-ads")]), 0, shell);
    d.querySelector(".video-ads")!.innerHTML = "<button>Omitir anuncio</button>";
    assert.equal(cleaner.apply([rule("div.video-ads")]), 0, shell);
  }
});

test("standalone YouTube controls remain protected outside a player wrapper", () => {
  const d = doc('<div class="ytp-ad-skip-button-container"><button>رد کردن آگهی</button></div>');
  assert.deepEqual(collectCandidates(d), []);
  assert.equal(createCleaner(d).apply([rule("div.ytp-ad-skip-button-container")]), 0);
});

test("HTML media and its wrapper cannot be hidden even when labelled as ads or consent", () => {
  for (const tag of ["video", "audio"]) {
    const d = doc(`<div class="cookie-ad-banner"><${tag} controls></${tag}></div>`);
    assert.deepEqual(collectCandidates(d), []);
    assert.equal(createCleaner(d).apply([rule("div.cookie-ad-banner")]), 0);
  }
});

test("a previously hidden wrapper is restored when a player mounts inside it", () => {
  const d = doc(
    '<main><div class="ad-wrapper" style="display:grid!important"><div class="ad-slot">Advertisement</div></div></main>',
  );
  const cleaner = createCleaner(d);
  const rules = [rule("div.ad-slot")];
  assert.equal(cleaner.apply(rules), 1);
  const wrapper = d.querySelector(".ad-wrapper") as HTMLElement;
  assert.equal(wrapper.style.display, "none");
  d.querySelector(".ad-slot")!.innerHTML = player;
  assert.equal(cleaner.apply(rules), 0);
  assert.equal(wrapper.style.display, "grid");
  assert.equal(wrapper.style.getPropertyPriority("display"), "important");
  assert.doesNotMatch(d.documentElement.outerHTML, /data-unclutter-/);
});

test("a shared selector is rejected when any match is a player control", () => {
  const d = doc(
    `<div class="ad-banner">Sponsor</div><div class="html5-video-player"><div class="ad-banner"><button>Skip ad</button></div></div>`,
  );
  assert.deepEqual(matchingElements(d, "div.ad-banner"), []);
});
