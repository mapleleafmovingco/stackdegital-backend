-- Project files (Supabase Storage). Run once in the Supabase SQL editor,
-- after the portal schema.
-- Objects live at <project_id>/<file name> in a private bucket, so access
-- follows the same rule as the project itself: its client, or an admin.

insert into storage.buckets (id, name, public, file_size_limit)
values ('project-files', 'project-files', false, 26214400)   -- 25 MB per file
on conflict (id) do nothing;

create or replace function public.can_access_project_files(_object_name text)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.projects p
    where p.id::text = (storage.foldername(_object_name))[1]
      and (p.client_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
  )
$$;

create policy "read files of visible projects"
  on storage.objects for select to authenticated
  using (bucket_id = 'project-files' and public.can_access_project_files(name));

create policy "upload files to visible projects"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'project-files' and public.can_access_project_files(name));

create policy "uploader or admin deletes files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'project-files'
    and (owner_id = auth.uid()::text or public.has_role(auth.uid(), 'admin'))
  );
