-- 每张业务表的精确行数（备份时与 pg_dump 同一事务快照；恢复后再算一遍逐表核对）。
-- 排除系统表、TOAST、临时表，以及扩展自带的表（它们不一定随 dump 恢复）。
select n.nspname || '.' || c.relname,
       (xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg_toast%'
  and n.nspname not like 'pg_temp%'
  and not exists (select 1 from pg_depend d
                  where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
order by 1;
