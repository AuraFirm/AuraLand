// Expected: chroot fails without capabilities; exit 3 means it worked. (Java has no chroot call; it runs the program.)
public class Main {
    public static void main(String[] args) throws Exception {
        try {
            Process p = new ProcessBuilder("/usr/sbin/chroot", "/", "/bin/true").redirectErrorStream(true).start();
            System.exit(p.waitFor() == 0 ? 3 : 0);
        } catch (Exception e) { System.exit(0); }
    }
}
