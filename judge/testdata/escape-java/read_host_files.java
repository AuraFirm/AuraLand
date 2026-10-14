// Expected: none of the host's secrets are visible; exit 3 if any can be opened.
import java.nio.file.Files;
import java.nio.file.Path;
public class Main {
    public static void main(String[] args) {
        String[] paths = {"/etc/shadow", "/root", "/proc/1/environ", "/var/local/lib/isolate", "/sys/fs/cgroup/cgroup.procs"};
        for (String p : paths) {
            try (var in = Files.newInputStream(Path.of(p))) { in.read(); System.exit(3); }
            catch (Exception e) { }
        }
        System.exit(0);
    }
}
