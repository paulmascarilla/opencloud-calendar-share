// Browser picked by the UI tests: BROWSER=chromium (default, CHROMIUM=<executable>) or BROWSER=firefox (Playwright's
// Firefox build: `npx playwright-core install firefox`, or FIREFOX=<executable>).
import { chromium, firefox } from 'playwright-core'
export const browserName = process.env.BROWSER ?? 'chromium'
export const browserType = browserName === 'firefox' ? firefox : chromium
const executablePath = browserName === 'firefox' ? process.env.FIREFOX : (process.env.CHROMIUM ?? '/snap/bin/chromium')
export const launchOptions = { headless: true, ...(executablePath ? { executablePath } : {}) }
export const launch = () => browserType.launch(launchOptions)
