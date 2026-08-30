import { describe, expect, it } from "vitest";

import {
  fetchEcbUsdCnyReferenceCross,
  loadEcbFxConfig,
  parseEcbUsdCnyReferenceCross,
} from "../src/ecb-fx.js";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Envelope><Cube><Cube time="2026-08-28">
  <Cube currency="USD" rate="1.1643"/>
  <Cube currency="CNY" rate="7.8251"/>
</Cube><Cube time="2026-08-27">
  <Cube currency="USD" rate="1.15"/>
  <Cube currency="CNY" rate="7.75"/>
</Cube></Cube></Envelope>`;

describe("ECB USD/CNY reference cross", () => {
  it("derives CNY per USD from same-day EUR reference rates", () => {
    expect(parseEcbUsdCnyReferenceCross({
      xml: XML,
      effectiveDate: "2026-08-28",
      observedAt: "2026-08-28T21:50:00.000Z",
    })).toEqual({
      schema: "twofold.ecb_usd_cny_reference_cross/v1",
      effectiveDate: "2026-08-28",
      eurToUsd: "1.1643",
      eurToCny: "7.8251",
      cnyPerUsd: "6.720862320708",
      derivation: "EUR_CNY_DIV_EUR_USD_HALF_UP_12",
      authority: "ECB_REFERENCE_CROSS",
      observedAt: "2026-08-28T21:50:00.000Z",
      availableAt: "2026-08-28T21:50:00.000Z",
    });
  });

  it("fails closed when the date or either official rate is absent", () => {
    expect(() => parseEcbUsdCnyReferenceCross({
      xml: XML,
      effectiveDate: "2026-08-26",
      observedAt: "2026-08-28T21:50:00.000Z",
    })).toThrow("date is absent");
    expect(() => parseEcbUsdCnyReferenceCross({
      xml: XML.replace('currency="CNY"', 'currency="JPY"'),
      effectiveDate: "2026-08-28",
      observedAt: "2026-08-28T21:50:00.000Z",
    })).toThrow("CNY rate is absent");
  });

  it("captures the exact trusted ECB response and derived cross", async () => {
    const response = new Response(XML, {
      status: 200,
      headers: { "content-type": "application/xml" },
    });
    Object.defineProperty(response, "url", {
      value: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
    });
    const delivery = await fetchEcbUsdCnyReferenceCross(
      loadEcbFxConfig({}),
      {
        effectiveDate: "2026-08-28",
        now: () => new Date("2026-08-28T21:50:00.000Z"),
        fetchImplementation: async () => response,
      },
    );
    expect(delivery).toMatchObject({
      schema: "twofold.ecb_usd_cny_delivery/v1",
      rawXml: XML,
      cross: { cnyPerUsd: "6.720862320708", status: "ESTIMATED" },
      sourceUrl:
        "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
    });
    expect(delivery.objectPath).toBe(
      `competition-sources/ecb/${delivery.envelopeSha256}.json`,
    );
    expect(JSON.parse(delivery.envelopeCanonicalJson)).toMatchObject({
      rawBodySha256: delivery.rawBodySha256,
      observedAt: "2026-08-28T21:50:00.000Z",
    });
  });

  it("uses the latest already-published reference day for a payable date", async () => {
    const response = new Response(XML, {
      status: 200,
      headers: { "content-type": "application/xml" },
    });
    Object.defineProperty(response, "url", {
      value: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
    });
    const delivery = await fetchEcbUsdCnyReferenceCross(
      loadEcbFxConfig({}),
      {
        effectiveDate: "2026-08-30",
        allowPreviousDate: true,
        now: () => new Date("2026-08-30T13:30:00.000Z"),
        fetchImplementation: async () => response,
      },
    );

    expect(delivery.cross).toMatchObject({
      effectiveDate: "2026-08-28",
      observedAt: "2026-08-30T13:30:00.000Z",
    });
  });

  it("rejects a non-ECB source before sending credentials or traffic", () => {
    expect(() => loadEcbFxConfig({
      TWOFOLD_ECB_FX_URL: "https://example.com/rates.xml",
    })).toThrow("trusted ECB");
  });
});
