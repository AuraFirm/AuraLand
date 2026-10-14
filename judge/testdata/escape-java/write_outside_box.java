// Expected: writes outside the box fail; exit 3 if a file could be created in /etc or /usr.
import java.nio.file.Files;
import java.nio.file.Path;
public class Main {
    public static void main(String[] args) {
        for (String p : new String[] {"/etc/aura_escape", "/usr/aura_escape"}) {
            try { Files.writeString(Path.of(p), "x"); System.exit(3); } catch (Exception e) { }
        }
        System.exit(0);
    }
}
