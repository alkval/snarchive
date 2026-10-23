// Frozen pre-Section-28 chronological query (212a589). Benchmark and equivalence oracle only.
// Parameter order is shared with the current query. Never used by the application.
export function baselineSql(direction: 'next' | 'previous'): string {
  const [newer, older, before, order] = direction === 'next' ? ['<', '<', '>', 'sortDay DESC,sortTime DESC,id ASC'] : ['>', '>', '<', 'sortDay ASC,sortTime ASC,id DESC'];
  return `WITH facts AS (
      SELECT m.id,
        EXISTS(SELECT 1 FROM library_favorites WHERE memory_id=m.id) AS favorite,
        (SELECT min(day) FROM library_dates WHERE memory_id=m.id) AS day,
        (SELECT min(value) FROM library_dates WHERE memory_id=m.id AND kind='instant') AS instant,
        (SELECT CASE WHEN count(DISTINCT day)>1 OR count(DISTINCT CASE WHEN kind='instant' THEN value END)>1 THEN 1 ELSE 0 END FROM library_dates WHERE memory_id=m.id) AS dateConflict,
        (SELECT count(*) FROM memory_objects WHERE memory_id=m.id AND role='photo') AS photos,
        (SELECT count(*) FROM memory_objects WHERE memory_id=m.id AND role='video') AS videos,
        (SELECT count(*) FROM memory_objects WHERE memory_id=m.id AND role='overlay') AS overlays
      FROM memories m WHERE EXISTS(SELECT 1 FROM memory_objects WHERE memory_id=m.id AND role!='overlay')
    ), ordered AS (
      SELECT *, CASE WHEN dateConflict=0 THEN coalesce(day,'') ELSE '' END AS sortDay,
        CASE WHEN dateConflict=0 THEN coalesce(instant,'') ELSE '' END AS sortTime FROM facts
    ) SELECT json_group_array(json_object('id',id,'day',day,'instant',instant,'dateConflict',dateConflict,
      'favorite',favorite,'photos',photos,'videos',videos,'overlays',overlays,'sortDay',sortDay,'sortTime',sortTime)) AS data FROM (
      SELECT * FROM ordered WHERE (?=1 OR sortDay${newer}? OR (sortDay=? AND sortTime${older}?) OR (sortDay=? AND sortTime=? AND id${before}?))
        AND (?='all' OR (?='photos' AND photos>0) OR (?='videos' AND videos>0))
        AND (?=0 OR favorite=1) AND (?='' OR (dateConflict=0 AND substr(day,1,7)=?))
        AND (?='' OR (dateConflict=0 AND substr(day,6,5)=substr(?,6,5) AND substr(day,1,4)<substr(?,1,4)))
      ORDER BY ${order} LIMIT ?
    )`;
}
