-- Revocations caused by deleting a device used to leave no history entry; the Activity feed rebuilt them from the
-- connection rows under the id `device-deleted:<connection id>`. The devices flow now records real entries, so write
-- the past ones once under the same ids. Re-running adds nothing.
INSERT INTO `connection_events` (`id`, `owner_id`, `token_id`, `token_name`, `kind`, `actor_name`, `at`, `detail`)
SELECT 'device-deleted:' || `id`, `owner_id`, `id`, `name`, 'revoked', `revoked_by_name`, `revoked_at`, '{"reason":"device_deleted"}'
FROM `agent_tokens`
WHERE `revoked_reason` = 'device_deleted' AND `revoked_at` IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM `connection_events` WHERE `connection_events`.`id` = 'device-deleted:' || `agent_tokens`.`id`);
