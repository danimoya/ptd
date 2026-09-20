import React from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const CertifiedInvoiceGlimpse = (await import("../../client/src/features/landing/CertifiedInvoiceGlimpse")).default;
const { LINES, SIGNED_DIGEST, SIGNED_TOTAL, canonical, fingerprint, money, padded, total, verdictFor, hours } =
  await import("../../client/src/features/landing/CertifiedInvoiceGlimpse");

/**
 * The argument this glimpse makes is that a changed line cannot hide. So the
 * tests are about exactly that: the digest has to be a function of the lines
 * and nothing else, and the verdict has to name which line moved.
 */

describe("the signed form of a line", () => {
  it("is stable, and independent of how the line is rendered", () => {
    expect(canonical(LINES[0])).toBe("1|SEC-1|human|200|0|300.00");
    expect(canonical(LINES[2])).toBe("3|SEC-2|agent|95|152000|12.87");
  });

  it("is the whole input to the digest", () => {
    expect(fingerprint(LINES)).toBe(SIGNED_DIGEST);
    expect(fingerprint([...LINES])).toBe(SIGNED_DIGEST);
    expect(fingerprint(padded())).not.toBe(SIGNED_DIGEST);
  });
});

describe("the totals", () => {
  it("add up to the signed figure", () => {
    expect(total(LINES)).toBe(972.87);
    expect(SIGNED_TOTAL).toBe(972.87);
  });

  it("move by exactly the padded hour", () => {
    expect(total(padded())).toBe(1062.87);
    expect(money(total(padded()))).toBe("$1,062.87");
    expect(hours(200)).toBe("3h 20m");
    expect(hours(260)).toBe("4h 20m");
  });
});

describe("the verdict", () => {
  it("verifies the invoice as issued", () => {
    const v = verdictFor(LINES);
    expect(v.ok).toBe(true);
    expect(v.headline).toBe("Verified");
  });

  it("names the line that moved, and by how much", () => {
    const v = verdictFor(padded());
    expect(v.ok).toBe(false);
    expect(v.headline).toBe("Not verified");
    expect(v.reason).toContain("Line 1");
    expect(v.reason).toContain("3h 20m");
    expect(v.reason).toContain("4h 20m");
    expect(v.reason).toContain("$300.00");
    expect(v.reason).toContain("$390.00");
  });
});

describe("the panel", () => {
  it("flips from verified to not verified when a line is padded, and back", () => {
    render(<CertifiedInvoiceGlimpse />);

    expect(screen.getByTestId("verify-headline")).toHaveTextContent("Verified");
    expect(screen.getByTestId("invoice-total")).toHaveTextContent("$972.87");

    fireEvent.click(screen.getByTestId("tamper-toggle"));

    expect(screen.getByTestId("verify-headline")).toHaveTextContent("Not verified");
    expect(screen.getByTestId("invoice-total")).toHaveTextContent("$1,062.87");
    expect(screen.getByTestId("verify-reason").textContent).toContain("Line 1 changed after signing");
    expect(screen.getByTestId("invoice-line-1").textContent).toContain("edited after signing");

    fireEvent.click(screen.getByTestId("tamper-toggle"));

    expect(screen.getByTestId("verify-headline")).toHaveTextContent("Verified");
    expect(screen.getByTestId("invoice-total")).toHaveTextContent("$972.87");
  });

  it("shows the recomputed digest diverging from the signed one", () => {
    render(<CertifiedInvoiceGlimpse />);
    const before = screen.getByTestId("verify-digest").textContent;
    expect(before).toContain(SIGNED_DIGEST);

    fireEvent.click(screen.getByTestId("tamper-toggle"));
    expect(screen.getByTestId("verify-digest").textContent).not.toBe(before);
  });
});
