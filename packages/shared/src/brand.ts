/** Shared product identity. TODO: replace provisional logo/colors with approved assets. */
export const brand = Object.freeze({
  name: "Lead My Company",
  shortName: "LMC",
  tagline: "Lead My Company helps service businesses capture, engage, and convert more leads into booked jobs — automatically, 24/7.",
  domain: "leadmycompany.com",
  url: "https://leadmycompany.com",
  logoPath: "/brand/lmc-logo.svg",
  colors: Object.freeze({ primary: "#0f172a", onPrimary: "#ffffff", background: "#ffffff", foreground: "#0f172a" }),
  visualIdentityStatus: "provisional",
} as const);
