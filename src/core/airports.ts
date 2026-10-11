type AirportInfo = { codes: string; note?: string };

const AIRPORTS: Record<string, AirportInfo> = {
  // Metros and big cities
  delhi: { codes: "DEL" },
  "new delhi": { codes: "DEL" },
  gurgaon: { codes: "DEL" },
  gurugram: { codes: "DEL" },
  noida: { codes: "DEL" },
  mumbai: { codes: "BOM" },
  bombay: { codes: "BOM" },
  bengaluru: { codes: "BLR" },
  bangalore: { codes: "BLR" },
  hyderabad: { codes: "HYD" },
  chennai: { codes: "MAA" },
  madras: { codes: "MAA" },
  kolkata: { codes: "CCU" },
  calcutta: { codes: "CCU" },
  pune: { codes: "PNQ" },
  ahmedabad: { codes: "AMD" },
  jaipur: { codes: "JAI" },
  lucknow: { codes: "LKO" },
  chandigarh: { codes: "IXC" },
  indore: { codes: "IDR" },
  bhopal: { codes: "BHO" },
  nagpur: { codes: "NAG" },
  patna: { codes: "PAT" },
  bhubaneswar: { codes: "BBI" },
  guwahati: { codes: "GAU" },
  coimbatore: { codes: "CJB" },
  kochi: { codes: "COK" },
  cochin: { codes: "COK" },
  thiruvananthapuram: { codes: "TRV" },
  trivandrum: { codes: "TRV" },
  visakhapatnam: { codes: "VTZ" },
  vizag: { codes: "VTZ" },
  vadodara: { codes: "BDQ" },
  surat: { codes: "STV" },
  mangaluru: { codes: "IXE" },
  mangalore: { codes: "IXE" },
  // Popular destinations
  goa: { codes: "GOI,GOX" },
  udaipur: { codes: "UDR" },
  jodhpur: { codes: "JDH" },
  jaisalmer: { codes: "JSA" },
  amritsar: { codes: "ATQ" },
  varanasi: { codes: "VNS" },
  srinagar: { codes: "SXR" },
  leh: { codes: "IXL" },
  ladakh: { codes: "IXL" },
  "port blair": { codes: "IXZ" },
  andaman: { codes: "IXZ" },
  madurai: { codes: "IXM" },
  mysuru: { codes: "MYQ" },
  mysore: { codes: "MYQ" },
  dehradun: { codes: "DED" },
  bagdogra: { codes: "IXB" },
  // No airport: nearest one
  manali: { codes: "KUU", note: "Nearest airport is Kullu–Bhuntar (KUU), about 50 km from Manali." },
  munnar: { codes: "COK", note: "Nearest airport is Kochi (COK), about 110 km from Munnar." },
  coorg: { codes: "IXE", note: "Nearest airport is Mangaluru (IXE), about 140 km from Coorg." },
  rishikesh: { codes: "DED", note: "Nearest airport is Dehradun (DED), about 20 km from Rishikesh." },
  ooty: { codes: "CJB", note: "Nearest airport is Coimbatore (CJB), about 90 km from Ooty." },
  pondicherry: { codes: "MAA", note: "Nearest major airport is Chennai (MAA), about 150 km from Pondicherry." },
  puducherry: { codes: "MAA", note: "Nearest major airport is Chennai (MAA), about 150 km from Puducherry." },
  darjeeling: { codes: "IXB", note: "Nearest airport is Bagdogra (IXB), about 70 km from Darjeeling." },
  gokarna: { codes: "GOI,GOX", note: "Nearest airports are in Goa, about 140 km from Gokarna." },
  alleppey: { codes: "COK", note: "Nearest airport is Kochi (COK), about 80 km from Alleppey." },
  hampi: { codes: "VDY", note: "Nearest airport is Vidyanagar (VDY), about 40 km from Hampi." },
};

export function resolveAirport(city: string): AirportInfo | null {
  return AIRPORTS[city.trim().toLowerCase()] ?? null;
}

/** First airport code, for labels like "HYD → GOI". */
export function primaryCode(codes: string): string {
  return codes.split(",")[0];
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Close matches for a city we don't know, e.g. "Banglore" → ["bangalore"]. */
export function suggestCities(city: string, max = 3): string[] {
  const q = city.trim().toLowerCase();
  return Object.keys(AIRPORTS)
    .map((name) => ({ name, d: editDistance(q, name) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(q.length / 4)))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.name);
}
