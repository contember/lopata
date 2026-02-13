import { test, expect, describe } from "bun:test";
import { HTMLRewriter } from "../bindings/html-rewriter";

async function rewrite(html: string, setup: (rw: HTMLRewriter) => HTMLRewriter): Promise<string> {
	const response = new Response(html, {
		headers: { "content-type": "text/html" },
	});
	const result = setup(new HTMLRewriter()).transform(response);
	return await result.text();
}

describe("HTMLRewriter", () => {
	describe("element handler", () => {
		test("getAttribute and setAttribute", async () => {
			const output = await rewrite('<a href="http://example.com">link</a>', (rw) =>
				rw.on("a[href]", {
					element(el) {
						const href = el.getAttribute("href");
						if (href) {
							el.setAttribute("href", href.replace("http:", "https:"));
						}
					},
				}),
			);
			expect(output).toBe('<a href="https://example.com">link</a>');
		});

		test("removeAttribute", async () => {
			const output = await rewrite('<div class="foo" id="bar">text</div>', (rw) =>
				rw.on("div", {
					element(el) {
						el.removeAttribute("class");
					},
				}),
			);
			expect(output).toBe('<div id="bar">text</div>');
		});

		test("hasAttribute", async () => {
			let result = false;
			await rewrite('<div data-test>text</div>', (rw) =>
				rw.on("div", {
					element(el) {
						result = el.hasAttribute("data-test");
					},
				}),
			);
			expect(result).toBe(true);
		});

		test("tagName", async () => {
			let tag = "";
			await rewrite("<div>text</div>", (rw) =>
				rw.on("div", {
					element(el) {
						tag = el.tagName;
					},
				}),
			);
			expect(tag).toBe("div");
		});

		test("attributes iterator", async () => {
			const attrs: [string, string][] = [];
			await rewrite('<div class="a" id="b">x</div>', (rw) =>
				rw.on("div", {
					element(el) {
						for (const attr of el.attributes) {
							attrs.push(attr);
						}
					},
				}),
			);
			expect(attrs).toEqual([
				["class", "a"],
				["id", "b"],
			]);
		});

		test("setInnerContent with text", async () => {
			const output = await rewrite("<p>old content</p>", (rw) =>
				rw.on("p", {
					element(el) {
						el.setInnerContent("new content");
					},
				}),
			);
			expect(output).toBe("<p>new content</p>");
		});

		test("setInnerContent with html", async () => {
			const output = await rewrite("<p>old</p>", (rw) =>
				rw.on("p", {
					element(el) {
						el.setInnerContent("<strong>bold</strong>", { html: true });
					},
				}),
			);
			expect(output).toBe("<p><strong>bold</strong></p>");
		});

		test("before and after", async () => {
			const output = await rewrite("<p>text</p>", (rw) =>
				rw.on("p", {
					element(el) {
						el.before("BEFORE");
						el.after("AFTER");
					},
				}),
			);
			expect(output).toBe("BEFORE<p>text</p>AFTER");
		});

		test("before and after with html option", async () => {
			const output = await rewrite("<p>text</p>", (rw) =>
				rw.on("p", {
					element(el) {
						el.before("<hr>", { html: true });
						el.after("<br>", { html: true });
					},
				}),
			);
			expect(output).toBe("<hr><p>text</p><br>");
		});

		test("prepend and append", async () => {
			const output = await rewrite("<p>middle</p>", (rw) =>
				rw.on("p", {
					element(el) {
						el.prepend("start-", { html: false });
						el.append("-end", { html: false });
					},
				}),
			);
			expect(output).toBe("<p>start-middle-end</p>");
		});

		test("replace element", async () => {
			const output = await rewrite("<p>old</p>", (rw) =>
				rw.on("p", {
					element(el) {
						el.replace("<div>new</div>", { html: true });
					},
				}),
			);
			expect(output).toBe("<div>new</div>");
		});

		test("remove element", async () => {
			const output = await rewrite("<div><p>remove me</p><span>keep</span></div>", (rw) =>
				rw.on("p", {
					element(el) {
						el.remove();
					},
				}),
			);
			expect(output).toBe("<div><span>keep</span></div>");
		});

		test("removeAndKeepContent", async () => {
			const output = await rewrite("<div><b>bold text</b></div>", (rw) =>
				rw.on("b", {
					element(el) {
						el.removeAndKeepContent();
					},
				}),
			);
			expect(output).toBe("<div>bold text</div>");
		});
	});

	describe("end tag handler", () => {
		test("onEndTag name and before/after", async () => {
			const output = await rewrite("<div>content</div>", (rw) =>
				rw.on("div", {
					element(el) {
						el.onEndTag((endTag) => {
							expect(endTag.name).toBe("div");
							endTag.before("<!-- end -->", { html: true });
						});
					},
				}),
			);
			expect(output).toBe("<div>content<!-- end --></div>");
		});
	});

	describe("text handler", () => {
		test("text chunks", async () => {
			const texts: string[] = [];
			await rewrite("<p>hello world</p>", (rw) =>
				rw.on("p", {
					text(chunk) {
						if (chunk.text) texts.push(chunk.text);
					},
				}),
			);
			expect(texts.join("")).toBe("hello world");
		});

		test("replace text", async () => {
			const output = await rewrite("<p>old text</p>", (rw) =>
				rw.on("p", {
					text(chunk) {
						if (chunk.text) {
							chunk.replace("new text");
						}
					},
				}),
			);
			expect(output).toBe("<p>new text</p>");
		});

		test("remove text", async () => {
			const output = await rewrite("<p>remove me</p>", (rw) =>
				rw.on("p", {
					text(chunk) {
						chunk.remove();
					},
				}),
			);
			expect(output).toBe("<p></p>");
		});

		test("lastInTextNode", async () => {
			const lastFlags: boolean[] = [];
			await rewrite("<p>text</p>", (rw) =>
				rw.on("p", {
					text(chunk) {
						lastFlags.push(chunk.lastInTextNode);
					},
				}),
			);
			// There should be at least one chunk with lastInTextNode=true
			expect(lastFlags.some((f) => f === true)).toBe(true);
		});
	});

	describe("comment handler", () => {
		test("read and modify comments", async () => {
			const output = await rewrite("<div><!-- old comment --></div>", (rw) =>
				rw.on("div", {
					comments(comment) {
						expect(comment.text).toBe(" old comment ");
						comment.text = " new comment ";
					},
				}),
			);
			expect(output).toBe("<div><!-- new comment --></div>");
		});

		test("remove comment", async () => {
			const output = await rewrite("<div><!-- remove -->text</div>", (rw) =>
				rw.on("div", {
					comments(comment) {
						comment.remove();
					},
				}),
			);
			expect(output).toBe("<div>text</div>");
		});

		test("replace comment", async () => {
			const output = await rewrite("<div><!-- old --></div>", (rw) =>
				rw.on("div", {
					comments(comment) {
						comment.replace("replacement", { html: false });
					},
				}),
			);
			expect(output).toBe("<div>replacement</div>");
		});
	});

	describe("document handler", () => {
		test("doctype handler", async () => {
			let doctypeName = "";
			await rewrite("<!DOCTYPE html><html><body>test</body></html>", (rw) =>
				rw.onDocument({
					doctype(dt) {
						doctypeName = dt.name ?? "";
					},
				}),
			);
			expect(doctypeName).toBe("html");
		});

		test("end handler append", async () => {
			const output = await rewrite("<p>content</p>", (rw) =>
				rw.onDocument({
					end(end) {
						end.append("<script>injected</script>", { html: true });
					},
				}),
			);
			expect(output).toBe("<p>content</p><script>injected</script>");
		});

		test("document-level text handler", async () => {
			const texts: string[] = [];
			await rewrite("<p>hello</p> world", (rw) =>
				rw.onDocument({
					text(chunk) {
						if (chunk.text) texts.push(chunk.text);
					},
				}),
			);
			expect(texts.join("")).toContain("hello");
			expect(texts.join("")).toContain("world");
		});

		test("document-level comments handler", async () => {
			let commentText = "";
			await rewrite("<!-- top level -->", (rw) =>
				rw.onDocument({
					comments(comment) {
						commentText = comment.text;
					},
				}),
			);
			expect(commentText).toBe(" top level ");
		});
	});

	describe("CSS selectors", () => {
		test("class selector", async () => {
			let matched = false;
			await rewrite('<div class="target">x</div><div class="other">y</div>', (rw) =>
				rw.on("div.target", {
					element() {
						matched = true;
					},
				}),
			);
			expect(matched).toBe(true);
		});

		test("id selector", async () => {
			const output = await rewrite('<p id="main">old</p><p>other</p>', (rw) =>
				rw.on("p#main", {
					element(el) {
						el.setInnerContent("new");
					},
				}),
			);
			expect(output).toBe('<p id="main">new</p><p>other</p>');
		});

		test("attribute value selector", async () => {
			const output = await rewrite('<a href="/home">home</a><a href="/about">about</a>', (rw) =>
				rw.on('a[href="/about"]', {
					element(el) {
						el.setAttribute("class", "active");
					},
				}),
			);
			expect(output).toContain('class="active"');
			expect(output).toContain('href="/about"');
		});

		test("wildcard selector", async () => {
			let count = 0;
			await rewrite("<div>a</div><p>b</p><span>c</span>", (rw) =>
				rw.on("*", {
					element() {
						count++;
					},
				}),
			);
			expect(count).toBe(3);
		});
	});

	describe("chaining and multiple handlers", () => {
		test("multiple .on() handlers", async () => {
			const output = await rewrite('<div class="a">x</div><p class="b">y</p>', (rw) =>
				rw
					.on("div", {
						element(el) {
							el.setAttribute("id", "d1");
						},
					})
					.on("p", {
						element(el) {
							el.setAttribute("id", "p1");
						},
					}),
			);
			expect(output).toContain('id="d1"');
			expect(output).toContain('id="p1"');
		});

		test("element and document handlers together", async () => {
			const output = await rewrite("<p>content</p>", (rw) =>
				rw
					.on("p", {
						element(el) {
							el.setAttribute("class", "styled");
						},
					})
					.onDocument({
						end(end) {
							end.append("<!-- footer -->", { html: true });
						},
					}),
			);
			expect(output).toBe('<p class="styled">content</p><!-- footer -->');
		});
	});

	describe("transform behavior", () => {
		test("preserves response status and headers", async () => {
			const original = new Response("<p>x</p>", {
				status: 201,
				statusText: "Created",
				headers: { "x-custom": "test", "content-type": "text/html" },
			});
			const result = new HTMLRewriter()
				.on("p", { element() {} })
				.transform(original);

			expect(result.status).toBe(201);
			expect(result.statusText).toBe("Created");
			expect(result.headers.get("x-custom")).toBe("test");
		});

		test("removes content-length header", async () => {
			const original = new Response("<p>x</p>", {
				headers: { "content-length": "8" },
			});
			const result = new HTMLRewriter()
				.on("p", { element() {} })
				.transform(original);

			expect(result.headers.get("content-length")).toBeNull();
		});

		test("handles null body response", () => {
			const original = new Response(null, { status: 204 });
			const result = new HTMLRewriter().transform(original);
			expect(result.status).toBe(204);
			expect(result.body).toBeNull();
		});

		test("handles large HTML with multiple chunks", async () => {
			// Create HTML large enough to be chunked
			const items = Array.from({ length: 500 }, (_, i) => `<li class="item">${i}</li>`).join("");
			const html = `<ul>${items}</ul>`;
			let count = 0;

			const output = await rewrite(html, (rw) =>
				rw.on("li.item", {
					element() {
						count++;
					},
				}),
			);

			expect(count).toBe(500);
			expect(output).toContain("<ul>");
			expect(output).toContain("</ul>");
		});
	});
});
