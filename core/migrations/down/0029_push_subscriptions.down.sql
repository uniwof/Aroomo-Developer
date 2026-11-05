-- 回退 0029。会删除全部推送订阅（设备要在设置里重新打开推送提醒），不影响其他数据。
DROP TABLE IF EXISTS push_subscriptions;
DELETE FROM core_schema_migrations WHERE version = '0029_push_subscriptions.sql';
