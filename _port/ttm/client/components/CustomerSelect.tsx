
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Pencil, Trash2, Check, X } from "lucide-react";
import { useState, useEffect } from "react";
import { getCustomers, createCustomer, updateCustomer, deleteCustomer } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

interface Customer {
  id: number;
  name: string;
  weeklyGoalHours: number | null;
  billingAddress: string | null;
  billingEmail: string | null;
}

interface CustomerSelectProps {
  onCustomerChange: (customerId: string | undefined) => void;
  selectedCustomerId?: string;
}

export function CustomerSelect({ onCustomerChange, selectedCustomerId }: CustomerSelectProps) {
  const { toast } = useToast();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<Customer>>({});
  const [newCustomer, setNewCustomer] = useState({
    name: "",
    weeklyGoalHours: "",
    billingAddress: "",
    billingEmail: "",
  });

  const refresh = async () => {
    try {
      const data = await getCustomers();
      setCustomers(data);
    } catch (error) {
      console.error("Error fetching customers:", error);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const addCustomer = async () => {
    if (!newCustomer.name) return;
    try {
      const customer = await createCustomer({
        name: newCustomer.name,
        weeklyGoalHours: parseInt(newCustomer.weeklyGoalHours) || undefined,
        billingAddress: newCustomer.billingAddress || undefined,
        billingEmail: newCustomer.billingEmail || undefined,
      });
      setCustomers([...customers, customer]);
      setNewCustomer({ name: "", weeklyGoalHours: "", billingAddress: "", billingEmail: "" });
      toast({ title: "Customer added" });
    } catch (error) {
      toast({ title: "Failed to add customer", variant: "destructive" });
    }
  };

  const startEdit = (c: Customer) => {
    setEditingId(c.id);
    setEditDraft({ ...c });
  };

  const saveEdit = async () => {
    if (editingId == null || !editDraft.name) return;
    try {
      const updated = await updateCustomer(editingId, {
        name: editDraft.name,
        weeklyGoalHours: editDraft.weeklyGoalHours ?? null,
        billingAddress: editDraft.billingAddress ?? null,
        billingEmail: editDraft.billingEmail ?? null,
      });
      setCustomers(customers.map((c) => (c.id === editingId ? updated : c)));
      setEditingId(null);
      toast({ title: "Customer updated" });
    } catch (error) {
      toast({ title: "Update failed", variant: "destructive" });
    }
  };

  const removeCustomer = async (id: number) => {
    try {
      await deleteCustomer(id);
      setCustomers(customers.filter((c) => c.id !== id));
      if (selectedCustomerId === id.toString()) onCustomerChange(undefined);
      toast({ title: "Customer deleted" });
    } catch (error) {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="w-full h-12 justify-between rounded-sm border-ink/30 bg-transparent font-serif text-base px-4 hover:bg-parchment-deep hover:border-ink/60"
        >
          <span
            className={
              selectedCustomerId
                ? "text-ink italic"
                : "text-ink-muted italic"
            }
          >
            {selectedCustomerId
              ? customers.find((c) => c.id.toString() === selectedCustomerId)?.name ||
                "Choose a client…"
              : "Choose a client or leave unattributed…"}
          </span>
          <span className="eyebrow text-[10px]">Select</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="w-[95vw] max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogTitle>Select or manage customers</DialogTitle>
        <DialogDescription>Pick an existing customer, edit one, or add a new one.</DialogDescription>

        <div className="space-y-3 border rounded-lg p-3 my-4">
          <div className="text-sm font-semibold">Add new customer</div>
          <Input
            placeholder="Customer name"
            value={newCustomer.name}
            onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })}
          />
          <Input
            type="number"
            placeholder="Weekly goal (hours)"
            value={newCustomer.weeklyGoalHours}
            onChange={(e) => setNewCustomer({ ...newCustomer, weeklyGoalHours: e.target.value })}
          />
          <Textarea
            placeholder="Billing address"
            value={newCustomer.billingAddress}
            onChange={(e) => setNewCustomer({ ...newCustomer, billingAddress: e.target.value })}
          />
          <Input
            type="email"
            placeholder="Billing email"
            value={newCustomer.billingEmail}
            onChange={(e) => setNewCustomer({ ...newCustomer, billingEmail: e.target.value })}
          />
          <Button className="w-full" onClick={addCustomer} disabled={!newCustomer.name}>
            Add Customer
          </Button>
        </div>

        <ScrollArea className="max-h-[300px]">
          <div className="grid gap-1">
            <Button
              variant="ghost"
              className="w-full justify-start font-normal"
              onClick={() => {
                onCustomerChange(undefined);
                setIsOpen(false);
              }}
            >
              No customer (break)
            </Button>
            {customers.map((customer) => (
              <div key={customer.id} className="border rounded-md p-2">
                {editingId === customer.id ? (
                  <div className="space-y-2">
                    <Input
                      value={editDraft.name ?? ""}
                      onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                      placeholder="Name"
                    />
                    <Input
                      type="number"
                      value={editDraft.weeklyGoalHours ?? ""}
                      onChange={(e) =>
                        setEditDraft({
                          ...editDraft,
                          weeklyGoalHours: e.target.value ? parseInt(e.target.value) : null,
                        })
                      }
                      placeholder="Weekly goal (hours)"
                    />
                    <Textarea
                      value={editDraft.billingAddress ?? ""}
                      onChange={(e) => setEditDraft({ ...editDraft, billingAddress: e.target.value })}
                      placeholder="Billing address"
                    />
                    <Input
                      type="email"
                      value={editDraft.billingEmail ?? ""}
                      onChange={(e) => setEditDraft({ ...editDraft, billingEmail: e.target.value })}
                      placeholder="Billing email"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveEdit} className="flex-1">
                        <Check className="h-4 w-4 mr-1" /> Save
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditingId(null)} className="flex-1">
                        <X className="h-4 w-4 mr-1" /> Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      className="flex-1 justify-start font-normal"
                      onClick={() => {
                        onCustomerChange(customer.id.toString());
                        setIsOpen(false);
                      }}
                    >
                      <div className="text-left">
                        <div>{customer.name}</div>
                        {customer.weeklyGoalHours ? (
                          <div className="text-xs text-muted-foreground">
                            Goal: {customer.weeklyGoalHours}h / week
                          </div>
                        ) : null}
                      </div>
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => startEdit(customer)} aria-label="Edit">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="icon" variant="ghost" aria-label="Delete">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete {customer.name}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This cannot be undone. Time entries tied to this customer will remain but no longer reference it.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => removeCustomer(customer.id)}>
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export default CustomerSelect;
