// Expected: ICMP reachability needs a raw socket or the network; exit 3 if anything outside answers.
import java.net.InetAddress;
public class Main {
    public static void main(String[] args) {
        try { System.exit(InetAddress.getByName("1.1.1.1").isReachable(500) ? 3 : 0); }
        catch (Exception e) { System.exit(0); }
    }
}
