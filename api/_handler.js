const { handleApiRequest } = require("../work/strategy-dashboard/server");

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, "https://bewin.local");
    const query = Object.fromEntries(url.searchParams.entries());
    const body =
      req.body !== undefined
        ? req.body
        : ["POST", "PUT", "PATCH"].includes(req.method || "")
          ? await readBody(req)
          : undefined;
    const payload = await handleApiRequest(url.pathname, query, req.headers, {
      method: req.method,
      body,
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(payload);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};
