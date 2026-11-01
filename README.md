# Trip Receipts

A simple phone-friendly app for tracking work receipts on business trips.

## Features

- **Trips**: one per work trip, with dates, destination, reporting currency and an optional budget.
- **Receipts**: take a photo with the camera (or pick an image/PDF), then enter amount, date, merchant, notes and category:
  Food & Drink, Taxi / Ride, Train / Bus, Flights, Hotel, Car / Fuel, Parking / Tolls, Other.
- **📸 Scan receipts**: take or pick photos (one receipt each, or a whole table of receipts in a
  single photo). Claude reads the merchant, date, total, currency and category of every receipt and
  cuts each one out of the photo. You check them on a review screen, then save.
  Needs your own Anthropic API key (⋮ → Receipt reading settings); costs about 1–2¢ per photo.
- **Foreign currency**: amounts in another currency are converted to your reporting currency
  automatically using European Central Bank rates for the receipt date (editable, e.g. to match your card statement).
- **Company card vs. personal**: tracks how much you're owed and lets you mark receipts as reimbursed.
- **Trip summary**: total, breakdown by category, budget remaining, and a warning for receipts missing a photo.
- **Export**:
  - CSV (opens in Excel / Google Sheets)
  - Printable report with every receipt photo (use "Save as PDF" in the print dialog)
  - Save/share all receipt photos at once (uses the phone's share sheet)
- **Backup / restore** everything as a JSON file (⋮ menu).
- Works offline and can be installed on your home screen.

All data stays **on your device** (in the browser's IndexedDB). The only things sent anywhere are
photos you choose to scan (to Anthropic's API, to read them) and currency/date pairs (to
frankfurter.dev, for exchange rates).
Back up now and then, because clearing your browser data deletes it.

## Using it

No build step. It's plain HTML/CSS/JS.

- **Host it with GitHub Pages** (easiest way to use it on your phone): repo → Settings → Pages →
  deploy from branch → pick this branch and `/ (root)`. Open the URL on your phone, then
  "Add to Home Screen" (Safari share menu / Chrome ⋮ menu).
- **Run it locally**: `python3 -m http.server` in this folder, then open http://localhost:8000.
