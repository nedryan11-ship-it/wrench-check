const fcKey = process.env.FIRECRAWL_API_KEY;
async function run() {
  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + fcKey },
    body: JSON.stringify({
      query: "site:bringatrailer.com sold 1997 Land Rover Defender 90",
      limit: 3
    })
  });
  const data = await res.json();
  console.log(JSON.stringify(data.data[0], null, 2));
}
run();
