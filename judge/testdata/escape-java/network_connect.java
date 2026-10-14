// Expected: no network; exit 3 if a connection to anything succeeds.
import java.net.InetSocketAddress;
import java.net.Socket;
public class Main {
    public static void main(String[] args) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("1.1.1.1", 53), 500);
            System.exit(3);
        } catch (Exception e) { System.exit(0); }
    }
}
