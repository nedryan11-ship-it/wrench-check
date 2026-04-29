import { scrapeListingUrlFast } from "./lib/vehicleDatabases/fastScrape";
import { config } from "dotenv";
config({path: ".env.local"});

async function main() {
  const url = process.argv[2];
  const intel = await scrapeListingUrlFast(url);
  console.log(JSON.stringify(intel, null, 2));
}
main();
