export default function handler(req, res) {
  if (req.method === "HEAD") return res.status(200).end();
  if (req.method === "POST") {
    console.log(req.body);
    return res.status(200).json({ ok: true });
  }
  return res.status(405).end();
}
