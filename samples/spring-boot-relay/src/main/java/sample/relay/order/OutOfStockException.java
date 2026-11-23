package sample.relay.order;

/** 재고 부족. 트랜잭션이 롤백되므로 같은 트랜잭션에서 쓴 outbox 행도 함께 사라진다. */
public class OutOfStockException extends RuntimeException {
    public OutOfStockException(String sku) {
        super("재고 부족: " + sku);
    }
}
