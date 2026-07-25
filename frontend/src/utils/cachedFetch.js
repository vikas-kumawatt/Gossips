import { getCachedRequest, setCachedRequest } from "./requestCache";

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const cachedFetchJson = async (
  url,
  init = {},
  { ttlMs = 60_000, cacheKey = "" } = {}
) => {
  const key =
    cacheKey ||
    `v1::public::FETCH::${url}::${stableStringify({
      method: init?.method || "GET",
    })}`;

  const cached = await getCachedRequest(key).catch(() => null);
  if (cached && Date.now() - cached.ts <= ttlMs) {
    return cached.data;
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Fetch ${res.status}`);
  }
  const data = await res.json();
  await setCachedRequest(key, { ts: Date.now(), data }).catch(() => {});
  return data;
};
