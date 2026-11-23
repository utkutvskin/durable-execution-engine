create function dequeue_lane_namespaces() returns setof uuid
language plpgsql
stable
rows 10
set search_path from current
as $$
begin
  return query select namespace.id from namespaces namespace;
end;
$$;
