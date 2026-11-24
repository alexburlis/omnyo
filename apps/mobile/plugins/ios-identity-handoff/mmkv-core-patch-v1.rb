require "digest"
require "json"
require "pathname"
require "securerandom"

module OmnyoMmkvCorePatchV1
  def self.apply(installer, ios_root = __dir__)
    spec = JSON.parse(File.binread(File.join(__dir__, "mmkv-core-patch-v1.json")))
    raise "Unsupported Omnyo MMKV patch manifest" unless spec.fetch("version") == 1 && spec.fetch("pod") == "MMKVCore" && spec.fetch("podVersion") == "2.4.0"
    targets = installer.pod_targets.select { |target| target.pod_name == "MMKVCore" }
    raise "The pinned MMKVCore owner is missing or ambiguous" unless targets.length == 1 && targets.first.root_spec.version.to_s == "2.4.0"
    expected = Pathname.new(ios_root).realpath.join("Pods", "MMKVCore")
    declared = installer.sandbox.pod_dir("MMKVCore")
    raise "MMKV patch requires the job-owned Pods directory" unless expected.directory? && !expected.symlink? && declared.realpath == expected
    selected = spec.fetch("files").map do |entry|
      relative = Pathname.new(entry.fetch("path"))
      raise "Unsafe pinned MMKV source path" if relative.absolute? || relative.each_filename.any? { |part| [".", ".."].include?(part) }
      path = expected.join(relative)
      raise "MMKV source escapes its owning Pod" unless path.file? && !path.symlink? && path.realpath.to_s.start_with?(expected.to_s + File::SEPARATOR)
      original = File.binread(path)
      digest = Digest::SHA256.hexdigest(original)
      if digest == entry.fetch("afterSha256")
        [path, original, false]
      else
        raise "Pinned MMKV source changed before migration patch" unless digest == entry.fetch("beforeSha256")
        result = original.dup
        entry.fetch("edits").each do |edit|
          before = edit.fetch("before")
          raise "Pinned MMKV patch span is ambiguous" unless result.index(before) && result.index(before) == result.rindex(before)
          result = result.sub(before) { edit.fetch("after") }
        end
        raise "Pinned MMKV patched source hash disagrees" unless Digest::SHA256.hexdigest(result) == entry.fetch("afterSha256")
        [path, result, true]
      end
    end
    selected.each do |path, result, changed|
      next unless changed
      temporary = path.dirname.join(".omnyo-mmkv-" + SecureRandom.uuid)
      begin
        File.open(temporary, File::WRONLY | File::CREAT | File::EXCL, File.stat(path).mode & 0o777) do |file|
          file.write(result)
          file.flush
          file.fsync
        end
        File.rename(temporary, path)
        File.open(path.dirname, File::RDONLY) { |directory| directory.fsync }
      ensure
        File.unlink(temporary) if temporary.exist?
      end
    end
    raise "Pinned MMKV source readback failed" unless selected.zip(spec.fetch("files")).all? { |(path, _, _), entry| Digest::SHA256.file(path).hexdigest == entry.fetch("afterSha256") }
    { "version" => 1, "podVersion" => "2.4.0", "changed" => selected.count { |_, _, changed| changed } }
  end
end
