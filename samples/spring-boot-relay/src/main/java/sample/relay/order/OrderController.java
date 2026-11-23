package sample.relay.order;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {

    public record PlaceOrderRequest(String email, String sku, int quantity) {}

    private final OrderService orders;

    public OrderController(OrderService orders) {
        this.orders = orders;
    }

    @PostMapping("/orders")
    public ResponseEntity<OrderService.Placed> place(@RequestBody PlaceOrderRequest request) {
        if (request.email() == null || !request.email().contains("@") || request.sku() == null
                || request.quantity() < 1) {
            return ResponseEntity.badRequest().build();
        }
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(orders.placeOrder(request.email(), request.sku(), request.quantity()));
    }

    @ExceptionHandler(OutOfStockException.class)
    public ResponseEntity<Map<String, String>> outOfStock(OutOfStockException e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", "OUT_OF_STOCK"));
    }
}
