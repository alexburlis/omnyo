export const LEGACY_PROCESS_TAGS_IMPORTER_V1 = String.raw`
sub read_process_tag_v1 {
  my ($tags, $entry) = @_;
  $tags->{$1} = $2 if $entry =~ /^(OMNYO_THREAD_ID|OMNYO_THREAD_STORAGE|OMNYO_KEEP_RUNNING|BB_THREAD_ID|BB_THREAD_STORAGE|BB_KEEP_RUNNING)=([^\t\r\n]*)$/;
}
sub import_legacy_process_tags_v1 {
  my ($tags) = @_;
  for my $pair (["BB_THREAD_ID", "OMNYO_THREAD_ID"], ["BB_THREAD_STORAGE", "OMNYO_THREAD_STORAGE"], ["BB_KEEP_RUNNING", "OMNYO_KEEP_RUNNING"]) {
    my ($legacy, $current) = @$pair;
    die "Conflicting process identity tags\n" if exists $tags->{$legacy} && exists $tags->{$current};
    $tags->{$current} = delete $tags->{$legacy} if exists $tags->{$legacy};
  }
}
`;
