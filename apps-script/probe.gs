// Paste into a new Apps Script project (script.google.com) and run probe().
// Tells us whether Google's egress IPs get through Pure Barre's Cloudflare block.
function probe() {
  var tz = 'America/Denver';
  var start = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var end = Utilities.formatDate(new Date(Date.now() + 7 * 864e5), tz, 'yyyy-MM-dd');
  var res = UrlFetchApp.fetch(
    'https://members.purebarre.com/api/v2/locations/purebarre-boulder-co/schedule_entries?start_date=' + start + '&end_date=' + end,
    {
      muteHttpExceptions: true,
      headers: {
        accept: 'application/json',
        origin: 'https://www.purebarre.com',
        referer: 'https://www.purebarre.com/location/boulder-co',
      },
    }
  );
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code === 200) {
    Logger.log('OK: ' + JSON.parse(body).schedule_entries.length + ' entries');
  } else {
    Logger.log('BLOCKED ' + code + ': ' + body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  }
}
