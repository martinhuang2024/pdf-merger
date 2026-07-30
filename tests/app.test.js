const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { resolveTheme } = require("../js/theme-init.js");
global.PDFLib = require("../vendor/pdf-lib.min.js");
require("../vendor/qpdf-wasm-base64.js");
global.Module = require("../vendor/qpdf.js");

const qpdfWasmPath = path.join(__dirname, ".qpdf-test.wasm");
fs.writeFileSync(qpdfWasmPath, Buffer.from(global.QPDF_WASM_BASE64, "base64"));
global.QPDF_WASM_PATH = qpdfWasmPath;

const {
  formatBytes,
  sanitizeFilename,
  buildDecryptedFilename,
  getTargetRotation,
  moveItem,
  summarizeFiles,
  isFileDrag,
  readFileBuffer,
  decryptPdfBytes,
  decryptPdfBatch,
  mergePdfBuffers,
} = require("../js/app.js");

test.after(() => {
  fs.rmSync(qpdfWasmPath, { force: true });
});

test("formatBytes formats common PDF sizes", () => {
  assert.equal(formatBytes(0), "0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(12 * 1024 * 1024), "12 MB");
});

test("sanitizeFilename removes invalid characters and duplicate PDF suffix", () => {
  assert.equal(sanitizeFilename(" 月報:最終版?.pdf "), "月報最終版");
  assert.equal(sanitizeFilename("..."), "合併文件");
});

test("buildDecryptedFilename keeps the original name and adds the decrypted suffix", () => {
  assert.equal(buildDecryptedFilename("月報.pdf"), "月報_已解密.pdf");
  assert.equal(buildDecryptedFilename("report final.PDF"), "report final_已解密.pdf");
});

test("getTargetRotation preserves mixed pages or rotates a mismatched page", () => {
  assert.equal(getTargetRotation(300, 500, 0, null), 0);
  assert.equal(getTargetRotation(300, 500, 0, "portrait"), 0);
  assert.equal(getTargetRotation(300, 500, 0, "landscape"), 90);
  assert.equal(getTargetRotation(500, 300, 0, "portrait"), 90);
  assert.equal(getTargetRotation(300, 500, 90, "portrait"), 180);
});

test("moveItem reorders without mutating the source", () => {
  const source = ["a", "b", "c"];
  assert.deepEqual(moveItem(source, 0, 2), ["b", "c", "a"]);
  assert.deepEqual(source, ["a", "b", "c"]);
});

test("summarizeFiles totals files, pages, and bytes", () => {
  assert.deepEqual(
    summarizeFiles([
      { pageCount: 2, file: { size: 100 } },
      { pageCount: 3, file: { size: 250 } },
    ]),
    { files: 2, pages: 5, bytes: 350 }
  );
});

test("isFileDrag distinguishes external files from internal queue dragging", () => {
  assert.equal(isFileDrag({ types: ["Files"] }), true);
  assert.equal(isFileDrag({ types: ["text/plain", "Files"] }), true);
  assert.equal(isFileDrag({ types: ["text/plain"] }), false);
  assert.equal(isFileDrag(null), false);
});

test("readFileBuffer reports completion when FileReader is unavailable", async () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const progress = [];
  const result = await readFileBuffer(
    { size: source.byteLength, arrayBuffer: async () => source.buffer },
    (loaded, total) => progress.push([loaded, total])
  );
  assert.deepEqual(new Uint8Array(result), source);
  assert.deepEqual(progress, [[4, 4]]);
});

test("resolveTheme keeps a saved choice and otherwise follows the device", () => {
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme(null, true), "dark");
  assert.equal(resolveTheme(null, false), "light");
});

test("mergePdfBuffers produces the expected total page count", async () => {
  async function makePdf(pageCount) {
    const pdf = await global.PDFLib.PDFDocument.create();
    for (let index = 0; index < pageCount; index += 1) pdf.addPage();
    return pdf.save();
  }
  const result = await mergePdfBuffers([await makePdf(2), await makePdf(3)], { title: "合併測試" });
  const loaded = await global.PDFLib.PDFDocument.load(result.bytes);
  assert.equal(result.pageCount, 5);
  assert.equal(loaded.getPageCount(), 5);
  assert.equal(loaded.getTitle(), "合併測試");
});

test("mergePdfBuffers can make every page portrait or keep mixed directions", async () => {
  async function makeSizedPdf(width, height) {
    const pdf = await global.PDFLib.PDFDocument.create();
    pdf.addPage([width, height]);
    return pdf.save();
  }

  const portraitBytes = await makeSizedPdf(300, 500);
  const landscapeBytes = await makeSizedPdf(500, 300);
  const mixed = await mergePdfBuffers([portraitBytes, landscapeBytes], {});
  const mixedPdf = await global.PDFLib.PDFDocument.load(mixed.bytes);
  assert.equal(mixedPdf.getPage(0).getRotation().angle, 0);
  assert.equal(mixedPdf.getPage(1).getRotation().angle, 0);

  const unified = await mergePdfBuffers(
    [portraitBytes, landscapeBytes],
    { orientation: "portrait" }
  );
  const unifiedPdf = await global.PDFLib.PDFDocument.load(unified.bytes);
  assert.equal(unifiedPdf.getPage(0).getRotation().angle, 0);
  assert.equal(unifiedPdf.getPage(1).getRotation().angle, 90);
  for (const page of unifiedPdf.getPages()) {
    const { width, height } = page.getSize();
    const rotated = page.getRotation().angle % 180 !== 0;
    const effectiveWidth = rotated ? height : width;
    const effectiveHeight = rotated ? width : height;
    assert.ok(effectiveWidth <= effectiveHeight);
  }
});

test("decryptPdfBytes removes a known PDF password", async () => {
  const plainPdf = await global.PDFLib.PDFDocument.create();
  plainPdf.addPage();
  const plainBytes = await plainPdf.save();
  const qpdf = await global.Module({
    locateFile: () => qpdfWasmPath,
    noInitialRun: true,
    print: () => {},
    printErr: () => {},
  });
  qpdf.FS.writeFile("/plain.pdf", plainBytes);
  const exitCode = qpdf.callMain([
    "--encrypt",
    "known-password",
    "known-password",
    "256",
    "--",
    "/plain.pdf",
    "/locked.pdf",
  ]);
  assert.equal(exitCode, 0);
  const lockedBytes = new Uint8Array(qpdf.FS.readFile("/locked.pdf"));

  await assert.rejects(
    () => decryptPdfBytes(lockedBytes, "wrong-password"),
    (error) => error && error.code === "PDF_PASSWORD_FAILED"
  );

  const unlockedBytes = await decryptPdfBytes(lockedBytes, "known-password");
  const unlockedPdf = await global.PDFLib.PDFDocument.load(unlockedBytes);
  assert.equal(unlockedPdf.getPageCount(), 1);
});

test("decryptPdfBatch processes files sequentially and keeps individual failures", async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const items = [
    { id: "first", bytes: new Uint8Array([1]) },
    { id: "second", bytes: new Uint8Array([2]) },
    { id: "third", bytes: new Uint8Array([3]) },
  ];
  const results = await decryptPdfBatch(items, "shared-password", async (bytes, password) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(`${bytes[0]}:${password}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (bytes[0] === 2) throw new Error("wrong password");
    return new Uint8Array([bytes[0], 9]);
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [
    "1:shared-password",
    "2:shared-password",
    "3:shared-password",
  ]);
  assert.deepEqual(results.map(({ id, ok }) => ({ id, ok })), [
    { id: "first", ok: true },
    { id: "second", ok: false },
    { id: "third", ok: true },
  ]);
});

test("HTML follows the html-tools local asset structure", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /vendor\/vue\.global\.prod\.js/);
  assert.match(html, /vendor\/pdf-lib\.min\.js/);
  assert.doesNotMatch(html, /<script src="vendor\/pdf(?:\.worker)?\.min\.js/);
  assert.doesNotMatch(html, /<script src="vendor\/qpdf(?:-wasm-base64)?\.js/);
  assert.match(html, /js\/theme-init\.js/);
  assert.match(html, /css\/styles\.css/);
  assert.match(html, /js\/app\.js/);
  assert.match(html, /v1\.8\.0/);
  assert.match(html, /class="file-read-progress is-drop-progress"/);
  assert.match(html, /class="file-read-progress is-queue-progress"/);
  assert.match(html, /readProgress\.percent/);
  assert.match(html, /class="overlay unlock-overlay"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, />\s*去除密碼\s*</);
  assert.match(html, />\s*批次去除密碼\s*</);
  assert.match(html, /v-model="selectedLockedIds"/);
  assert.match(html, /@submit\.prevent="unlockSelectedBatch"/);
  assert.match(html, />\s*單獨下載\s*</);
  assert.match(html, />\s*預覽\s*</);
  assert.match(html, /預覽合併結果/);
  assert.match(html, /ref="previewContainer"/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, />\s*統一頁面方向\s*</);
  assert.match(html, /未勾選時保留原始直橫混合/);
  assert.match(html, /\{\{ unlockTarget\.file\.name \}\}/);
  assert.doesNotMatch(html, /id="pdf-password"/);
  assert.match(
    html,
    /<section class="workspace"[\s\S]*?<input[\s\S]*?ref="fileInput"[\s\S]*?<label[\s\S]*?v-if="!queue\.length"/
  );
  assert.doesNotMatch(html, /@drop\.prevent="handleDrop"/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("whole page registers and removes external PDF drag listeners", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  assert.match(source, /document\.addEventListener\("dragenter", handlePageDragEnter\)/);
  assert.match(source, /document\.addEventListener\("dragover", handlePageDragOver\)/);
  assert.match(source, /document\.addEventListener\("drop", handlePageDrop\)/);
  assert.match(source, /document\.removeEventListener\("drop", handlePageDrop\)/);
  assert.match(source, /addFiles\(event\.dataTransfer\.files\)/);
});

test("heavy preview and decryption engines load only when requested", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  assert.match(source, /loadScriptOnce\("vendor\/pdf\.min\.js\?v=1\.8\.0"\)/);
  assert.match(source, /workerSrc = "vendor\/pdf\.worker\.min\.js\?v=1\.8\.0"/);
  assert.match(source, /loadScriptOnce\("vendor\/qpdf-wasm-base64\.js\?v=1\.8\.0"\)/);
  assert.match(source, /loadScriptOnce\("vendor\/qpdf\.js\?v=1\.8\.0"\)/);
});
