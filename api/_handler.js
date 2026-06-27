const { handleApiRequest } = require("../work/strategy-dashboard/server");

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, "https://bewin.local");
    const query = Object.fromEntries(url.searchParams.entries());
    const payload = await handleApiRequest(url.pathname, query);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(payload);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};
