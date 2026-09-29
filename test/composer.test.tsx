// The message box (5.2): the console's activation characters ("/" commands,
// "@" people, "#" tags), commands started by any command character, and
// @mentions / #tags highlighted in messages (a tag filters the conversation).

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseCommandLine } from "../client/src/lib/functions";
import { sanitizeComposer, sanitizeClientConfig, DEFAULT_COMPOSER } from "../client/src/lib/client-config";
import { linkify, tagsIn } from "../client/src/lib/linkify";

describe("activation characters", () => {
  it("defaults to / @ #, keeps one action per character, refuses letters and spaces", () => {
    expect(sanitizeClientConfig({}).composer).toEqual(DEFAULT_COMPOSER);
    const c = sanitizeComposer({ triggers: [{ char: "!", action: "functions" }, { char: "!", action: "tags" }, { char: "a", action: "tags" }, { char: " ", action: "tags" }, { char: "@", action: "mentions" }, { char: "~", action: "nope" }], tags: ["#Urgent", "meeting", "bad tag!"] });
    expect(c.triggers).toEqual([{ char: "!", action: "functions" }, { char: "@", action: "mentions" }]);
    expect(c.tags).toEqual(["urgent", "meeting"]);
  });

  it("a command starts with any command character", () => {
    expect(parseCommandLine("/dns example.com type=MX")).toEqual({ keyword: "dns", argText: "example.com type=MX" });
    expect(parseCommandLine("!dns example.com", ["/", "!"])).toEqual({ keyword: "dns", argText: "example.com" });
    expect(parseCommandLine("!dns example.com")).toBeNull(); // "!" is not a command character by default
    expect(parseCommandLine("hello /dns")).toBeNull();
  });
});

describe("mentions and tags in messages", () => {
  it("finds a message's #tags the way it shows them: whole tags only, no trailing dot", () => {
    expect(tagsIn("Hotovo #Release. A #release-notes a #v5.2 — http://x.test/#frag, (#ops)")).toEqual(["release", "release-notes", "v5.2", "ops"]);
    expect(tagsIn("#foo-bar").includes("foo")).toBe(false); // the filter for #foo does not take #foo-bar
    expect(tagsIn("no tags # here")).toEqual([]);
  });

  it("highlights @names, makes #tags buttons, keeps links", () => {
    const html = renderToStaticMarkup(<>{linkify("Hi @anna_k, see #Release-5 at https://example.com/x#frag and mail a@b.cz")}</>);
    expect(html).toContain('<span class="mention">@anna_k</span>');
    expect(html).toMatch(/<button[^>]*class="hashtag"[^>]*data-tag="release-5"[^>]*>#Release-5<\/button>/);
    expect(html).toContain('href="https://example.com/x#frag"');
    expect(html).not.toContain('class="mention">@b.cz'); // an e-mail is not a mention
  });
});
