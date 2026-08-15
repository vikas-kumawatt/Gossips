export const getGifs = async (req, res) => {
  const { query, limit = 24, offset = 0 } = req.query;
  const API_KEY = process.env.GIPHY_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: "Giphy API key not configured" });
  }

  const base = query
    ? `https://api.giphy.com/v1/gifs/search?api_key=${API_KEY}&q=${encodeURIComponent(query)}`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${API_KEY}`;

  try {
    const response = await fetch(`${base}&limit=${limit}&offset=${offset}&rating=pg-13`);
    if (!response.ok) {
      throw new Error(`Giphy API responded with ${response.status}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error fetching GIFs:", error);
    res.status(500).json({ error: "Failed to fetch GIFs" });
  }
};
