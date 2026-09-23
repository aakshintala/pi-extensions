// Test-only: pins pi's clock to 2026-09-20 12:00 in Asia/Kolkata (UTC+5:30),
// so /usage periods, buckets and axis labels are the same on every machine.
process.env.TZ = "Asia/Kolkata";
const NOW = Date.parse("2026-09-20T12:00:00+05:30");
const RealDate = Date;
class FixedDate extends RealDate {
	constructor(...args: any[]) {
		super(...((args.length > 0 ? args : [NOW]) as []));
	}
	static now() {
		return NOW;
	}
}
globalThis.Date = FixedDate as DateConstructor;

export default function () {}
