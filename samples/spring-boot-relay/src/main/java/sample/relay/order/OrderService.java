package sample.relay.order;

import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import sample.relay.mailo.MailRequestFactory;
import sample.relay.outbox.OutboxRepository;

/**
 * 비즈니스 트랜잭션 예시(RQ-021). 주문, 재고 차감, 메일 요청(outbox)을 한 트랜잭션에 쓴다.
 * 이 서비스는 Mailo를 호출하지 않는다. Mailo가 내려가 있어도 주문은 영향받지 않는다.
 */
@Service
public class OrderService {

    public record Placed(UUID orderId, UUID outboxId) {}

    private final JdbcClient jdbc;
    private final OutboxRepository outbox;
    private final MailRequestFactory mailRequests;

    public OrderService(JdbcClient jdbc, OutboxRepository outbox, MailRequestFactory mailRequests) {
        this.jdbc = jdbc;
        this.outbox = outbox;
        this.mailRequests = mailRequests;
    }

    @Transactional
    public Placed placeOrder(String email, String sku, int quantity) {
        UUID orderId = UUID.randomUUID();
        UUID outboxId = UUID.randomUUID(); // Idempotency-Key. 재시도에도 바뀌지 않는다.

        jdbc.sql("INSERT INTO orders (id, sku, quantity, customer_email) VALUES (:id, :sku, :qty, :email)")
                .param("id", orderId)
                .param("sku", sku)
                .param("qty", quantity)
                .param("email", email)
                .update();

        // 요청 JSON은 여기서 확정한다. 암호화를 켰다면 이 시점에 JWE로 만들어 outbox에 평문이 남지 않는다.
        outbox.insert(outboxId, mailRequests.orderConfirmation(email, orderId, sku, quantity));

        // 재고 차감 실패는 위 두 INSERT를 함께 롤백한다. 존재하지 않는 주문의 메일이 나가지 않는다.
        int updated = jdbc.sql("UPDATE inventory SET stock = stock - :qty WHERE sku = :sku AND stock >= :qty")
                .param("qty", quantity)
                .param("sku", sku)
                .update();
        if (updated == 0) {
            throw new OutOfStockException(sku);
        }
        return new Placed(orderId, outboxId);
    }
}
